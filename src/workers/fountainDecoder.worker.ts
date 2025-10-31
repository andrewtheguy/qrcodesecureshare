/// <reference lib="webworker" />

import { FountainDecoder } from '../utils/fountainCodeWasm';
import type { FountainMetadata, FountainChunk } from '../utils/fountainCodeWasm';
import { parseBinaryChunk, createChunkKey, validateChunkChecksum, crc32 } from '../../rust/fountain-wasm/pkg/fountain_wasm';

/**
 * Ensures the decoder is initialized before use
 */
function ensureDecoder(): void {
    if (!decoder) {
        throw new Error('Decoder not initialized');
    }
}


/**
 * Calculates progress for the current part in part-based mode or overall progress in normal mode
 * @param decoder - The fountain decoder instance
 * @param isPartBasedMode - Whether part-based mode is enabled
 * @returns Progress value as a fraction (0 to 1), or 0 if total blocks is 0
 */
function calculatePartProgress(decoder: FountainDecoder, isPartBasedMode: boolean): number {
    if (isPartBasedMode) {
        const currentPartDecodedBlocks = decoder.wasm.getCurrentPartDecodedBlockCount();
        const currentPartTotalBlocks = decoder.wasm.getCurrentPartTotalBlockCount();
        return currentPartTotalBlocks > 0 ? currentPartDecodedBlocks / currentPartTotalBlocks : 0;
    } else {
        // In non-part mode, part progress equals overall progress
        return decoder.wasm.getProgress();
    }
}

// Worker state
let decoder: FountainDecoder | null = null;
let metadata: FountainMetadata;
let lastDecodeAttemptTime = 0; // Throttle decode attempts (only send progress if new blocks decoded or 500ms passed)
let lastDecodedBlockCount = 0; // Track last decoded count to detect new blocks
let currentSessionId: number | null = null; // Track current session for reset

// Part-based transfer state (session settings)
let partBasedMode = false;
let partSize = 0;

// Message handler
self.onmessage = async (event: MessageEvent) => {
    const { type, id, ...data } = event.data;

    try {
        switch (type) {
            case 'initialize': {
                metadata = data.metadata as FountainMetadata;
                partBasedMode = data.partBasedMode || false;
                partSize = data.partSize || 0;
                const sessionId = data.sessionId as number | undefined;

                // Track session changes for logging
                if (sessionId !== undefined && sessionId !== currentSessionId) {
                    console.log(`[Worker] Session changed from ${currentSessionId} to ${sessionId}`);
                    currentSessionId = sessionId;
                } else if (!currentSessionId) {
                    currentSessionId = sessionId ?? null;
                }

                console.log(`[Worker] Initialized with sessionId: ${sessionId}, partBasedMode: ${partBasedMode}, partSize: ${partSize}`);

                try {
                    decoder = await FountainDecoder.create(metadata, partBasedMode, partSize);

                    // Set session ID in Rust decoder (clears dedup cache on session change)
                    if (sessionId !== undefined) {
                        decoder.wasm.setSessionId(sessionId);
                    }

                    lastDecodeAttemptTime = Date.now();
                    lastDecodedBlockCount = decoder.wasm.getDecodedBlockCount();
                    self.postMessage({ type: 'initialized', id, metadata });
                } catch (err) {
                    // Check for WASM initialization failure
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    if (errorMessage.includes('WASM_INIT_FAILED')) {
                        // Post structured error with code for UI to surface
                        self.postMessage({
                            type: 'error',
                            id,
                            code: 'WASM_INIT_FAILED',
                            error: 'Failed to initialize WASM decoder. The WASM bundle may not be loaded. Please refresh the page and try again.',
                            details: errorMessage
                        });
                    } else {
                        // Generic initialization error
                        self.postMessage({
                            type: 'error',
                            id,
                            error: `Failed to initialize decoder: ${errorMessage}`
                        });
                    }
                }
                break;
            }

            case 'processChunk': {
                ensureDecoder();
                const { binaryData } = data as { binaryData: Uint8Array };

                // Parse binary chunk in Rust (includes automatic part metadata extraction)
                let parsedChunk: FountainChunk & { checksumStart: number; partMetadata?: { currentPart: number; totalParts: number; partChecksum: Uint8Array } };
                try {
                    parsedChunk = parseBinaryChunk(binaryData, partBasedMode, metadata.totalSourceBlocks) as FountainChunk & { checksumStart: number; partMetadata?: { currentPart: number; totalParts: number; partChecksum: Uint8Array } };
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    self.postMessage({ type: 'error', id, error: `Parse error: ${errorMessage}` });
                    break;
                }

                const chunk = parsedChunk;

                // Validate checksum over complete chunk: seed(2) + degree(1) + numIndices(1) + indices(2N) + [partMetadata] + data
                // This is everything except magic bytes (first 2 bytes) and checksum itself (last 4 bytes)
                const checksumPayload = binaryData.slice(2, chunk.checksumStart);
                const computedChecksum = crc32(checksumPayload);

                // Validate using Rust function
                try {
                    const checksumValid = validateChunkChecksum(binaryData, chunk.checksumStart, computedChecksum);
                    if (!checksumValid) {
                        console.error(`[Worker] Checksum mismatch! Computed: ${computedChecksum}, checksumStart: ${chunk.checksumStart}`);
                        console.error(`[Worker] Payload length: ${checksumPayload.length}, total: ${binaryData.length}`);
                        console.error(`[Worker] partBasedMode: ${partBasedMode}, partMetadata:`, chunk.partMetadata);
                        self.postMessage({ type: 'error', id, error: 'Invalid checksum', seed: chunk.seed });
                        break;
                    }
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    self.postMessage({ type: 'error', id, error: `Checksum validation error: ${errorMessage}` });
                    break;
                }

                // Generate composite chunk key for deduplication (moved to Rust)
                const chunkKey = createChunkKey(chunk.seed, chunk.degree, chunk.indices);

                // Store part checksum in Rust if present
                if (chunk.partMetadata) {
                    // Set the part checksum in Rust for validation
                    try {
                        decoder!.wasm.setExpectedPartChecksum(chunk.partMetadata.currentPart, chunk.partMetadata.partChecksum);
                        // Log the checksum as hex for debugging
                        const checksumHex = Array.from(chunk.partMetadata.partChecksum)
                            .map(b => b.toString(16).padStart(2, '0'))
                            .join('');
                        console.log(`[Worker] Parsed part metadata: part ${chunk.partMetadata.currentPart + 1}/${chunk.partMetadata.totalParts}, checksum: ${checksumHex}`);
                    } catch (err) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        self.postMessage({ type: 'error', id, error: `Failed to set part checksum: ${errorMessage}` });
                        break;
                    }
                }

                // Process chunk with deduplication, validation, and part completion check (all in Rust)
                interface ProcessChunkResult {
                    is_duplicate: boolean;
                    blocks_decoded: number;
                    part_complete_info?: {
                        is_valid: boolean;
                        expected_checksum: string;
                        actual_checksum: string;
                        current_part: number;
                        total_parts: number;
                    };
                }
                let processResult: ProcessChunkResult;
                try {
                    processResult = decoder!.wasm.processChunkWithValidation(chunk, chunkKey) as unknown as ProcessChunkResult;
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    self.postMessage({ type: 'error', id, error: `Chunk processing error: ${errorMessage}` });
                    break;
                }

                // Handle duplicate chunks
                if (processResult.is_duplicate) {
                    self.postMessage({ type: 'chunkProcessed', id, duplicate: true, seed: chunk.seed });
                    break;
                }

                // Check throttling for decode attempt
                const now = Date.now();
                const decodedBlockCount = decoder!.wasm.getDecodedBlockCount();
                const hasNewBlocks = decodedBlockCount !== lastDecodedBlockCount;
                const shouldAttemptDecode = hasNewBlocks || (now - lastDecodeAttemptTime >= 500);

                // Convert part complete info if present
                let partCompleteInfo: { partComplete: boolean; isValid: boolean; expectedChecksum: string; actualChecksum: string; currentPart: number; totalParts: number } | undefined;
                if (processResult.part_complete_info) {
                    const pci = processResult.part_complete_info;
                    partCompleteInfo = {
                        partComplete: true,
                        isValid: pci.is_valid,
                        expectedChecksum: pci.expected_checksum,
                        actualChecksum: pci.actual_checksum,
                        currentPart: pci.current_part,
                        totalParts: pci.total_parts
                    };
                    if (pci.is_valid) {
                        console.log(`[Worker] Part ${pci.current_part + 1}/${pci.total_parts} complete and valid`);
                    }
                }

                if (shouldAttemptDecode) {
                    lastDecodeAttemptTime = now;
                    lastDecodedBlockCount = decodedBlockCount;

                    // Get overall progress
                    const overallProgress = decoder!.wasm.getProgress();
                    const isComplete = decoder!.isComplete();
                    const decodedBlockIndices = decoder!.wasm.getDecodedBlockIndices();

                    // Get part-specific progress
                    const partProgress = calculatePartProgress(decoder!, partBasedMode);
                    let currentPartDecodedBlocks: number | undefined;
                    let currentPartTotalBlocks: number | undefined;
                    let currentPartIndex: number | undefined;
                    let totalParts: number | undefined;
                    if (partBasedMode) {
                        const partInfo = decoder!.getPartInfo();
                        currentPartDecodedBlocks = decoder!.wasm.getCurrentPartDecodedBlockCount();
                        currentPartTotalBlocks = decoder!.wasm.getCurrentPartTotalBlockCount();
                        currentPartIndex = partInfo.currentPartIndex;
                        totalParts = partInfo.totalParts;
                    }

                    self.postMessage({
                        type: 'chunkProcessed',
                        id,
                        seed: chunk.seed,
                        decodedBlockCount,
                        overallProgress,
                        partProgress,
                        isComplete,
                        decodedBlockIndices,
                        currentPartDecodedBlocks,
                        currentPartTotalBlocks,
                        currentPartIndex,
                        totalParts,
                        partCompleteInfo
                    });

                    // If complete, trigger reconstruction and final validation
                    if (isComplete) {
                        const reconstructedData = decoder!.getDecodedData();
                        if (reconstructedData) {
                            const validationResult = decoder!.wasm.validateFinalChecksum(metadata.checksum);
                            const integrityOk = validationResult?.isValid ?? false;
                            self.postMessage({
                                type: 'complete',
                                id,
                                data: reconstructedData,
                                integrityOk,
                                expectedChecksum: validationResult?.expectedChecksum ?? metadata.checksum,
                                calculatedChecksum: validationResult?.actualChecksum ?? ''
                            }, [reconstructedData.buffer]);
                        }
                    }
                } else {
                    // Queue chunk and send current state without full decode check
                    const overallProgress = decoder!.wasm.getProgress();
                    const decodedBlockIndices = decoder!.wasm.getDecodedBlockIndices();

                    // Get part-specific info
                    const partProgress = calculatePartProgress(decoder!, partBasedMode);
                    let currentPartIndex: number | undefined;
                    let totalParts: number | undefined;
                    let currentPartDecodedBlocks: number | undefined;
                    let currentPartTotalBlocks: number | undefined;
                    if (partBasedMode) {
                        const partInfo = decoder!.getPartInfo();
                        currentPartIndex = partInfo.currentPartIndex;
                        totalParts = partInfo.totalParts;
                        currentPartDecodedBlocks = decoder!.wasm.getCurrentPartDecodedBlockCount();
                        currentPartTotalBlocks = decoder!.wasm.getCurrentPartTotalBlockCount();
                    }

                    self.postMessage({
                        type: 'chunkProcessed',
                        id,
                        seed: chunk.seed,
                        queued: true,
                        decodedBlockCount,
                        overallProgress,
                        partProgress,
                        isComplete: false,
                        decodedBlockIndices,
                        currentPartIndex,
                        totalParts,
                        currentPartDecodedBlocks,
                        currentPartTotalBlocks,
                        partCompleteInfo
                    });
                }
                break;
            }


            case 'getStatus': {
                ensureDecoder();
                const decodedBlockCount__ = decoder!.wasm.getDecodedBlockCount();
                const overallProgress_ = decoder!.wasm.getProgress();
                const isComplete_ = decoder!.isComplete();
                const decodedBlockIndices__ = decoder!.wasm.getDecodedBlockIndices();

                // Calculate part progress
                const partProgress_ = calculatePartProgress(decoder!, partBasedMode);

                self.postMessage({
                    type: 'status',
                    id,
                    decodedBlockCount: decodedBlockCount__,
                    overallProgress: overallProgress_,
                    partProgress: partProgress_,
                    isComplete: isComplete_,
                    decodedBlockIndices: decodedBlockIndices__
                });
                break;
            }

            case 'moveToNextPart': {
                ensureDecoder();
                if (!partBasedMode) {
                    self.postMessage({ type: 'error', id, error: 'Not in part-based mode' });
                    break;
                }

                const moved = decoder!.wasm.moveToNextPart();
                if (moved) {
                    const partInfo = decoder!.getPartInfo();
                    self.postMessage({
                        type: 'partTransitioned',
                        id,
                        newPartIndex: partInfo.currentPartIndex,
                        totalParts: partInfo.totalParts
                    });
                } else {
                    self.postMessage({ type: 'error', id, error: 'Failed to move to next part' });
                }
                break;
            }

            default:
                self.postMessage({ type: 'error', id, error: 'Unknown message type' });
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        self.postMessage({ type: 'error', id, error: errorMessage });
    }
};