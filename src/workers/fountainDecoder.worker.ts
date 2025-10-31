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
const receivedChunks: Set<string> = new Set(); // Composite key: "seed:degree:firstIdx:lastIdx"
const processedSeeds: Set<number> = new Set();
let metadata: FountainMetadata;
let lastDecodeAttemptTime = 0; // Throttle decode attempts to every 500ms
let lastDecodedBlockCount = 0; // Track last decoded count to detect new blocks
let currentSessionId: number | null = null; // Track current session for reset

// Part-based transfer state
let partBasedMode = false;
let partSize = 0;
const expectedPartChecksumBytes = new Map<number, Uint8Array>(); // Per-part checksums from sender as bytes, keyed by part index
let lastPartCompleteCheck = 0; // Throttle part completion checks

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

                // Reset received chunks if session changed or is new
                if (sessionId !== undefined && sessionId !== currentSessionId) {
                    console.log(`[Worker] Session changed from ${currentSessionId} to ${sessionId}, clearing chunk dedup cache`);
                    receivedChunks.clear();
                    currentSessionId = sessionId;
                } else if (!currentSessionId) {
                    // First initialization
                    receivedChunks.clear();
                    currentSessionId = sessionId ?? null;
                }

                console.log(`[Worker] Initialized with sessionId: ${sessionId}, partBasedMode: ${partBasedMode}, partSize: ${partSize}`);

                try {
                    decoder = await FountainDecoder.create(metadata, partBasedMode, partSize);
                    processedSeeds.clear();
                    expectedPartChecksumBytes.clear(); // Clear any previous part checksums
                    lastDecodeAttemptTime = Date.now();
                    lastDecodedBlockCount = decoder.wasm.getDecodedBlockCount();
                    lastPartCompleteCheck = 0;
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
                // Note: partChecksum is now Uint8Array (bytes) instead of string (hex)
                let parsedChunk: FountainChunk & { checksumStart: number; partMetadata?: { currentPart: number; totalParts: number; partChecksum: Uint8Array } };
                try {
                    parsedChunk = parseBinaryChunk(binaryData, partBasedMode, metadata.totalSourceBlocks) as FountainChunk & { checksumStart: number; partMetadata?: { currentPart: number; totalParts: number; partChecksum: Uint8Array } };
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    self.postMessage({ type: 'error', id, error: `Parse error: ${errorMessage}` });
                    break;
                }

                const chunk = parsedChunk;

                // Check for duplicate chunk using Rust-generated key
                const chunkKey = createChunkKey(chunk.seed, chunk.degree, chunk.indices);
                if (receivedChunks.has(chunkKey)) {
                    self.postMessage({ type: 'chunkProcessed', id, duplicate: true, seed: chunk.seed });
                    break;
                }

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

                // Add to received chunks using composite key
                receivedChunks.add(chunkKey);
                processedSeeds.add(chunk.seed);

                // Store part checksum if present (keep as bytes for Rust validation)
                if (chunk.partMetadata) {
                    expectedPartChecksumBytes.set(chunk.partMetadata.currentPart, chunk.partMetadata.partChecksum);
                    // Log the checksum as hex for debugging (convert bytes to hex)
                    const checksumHex = Array.from(chunk.partMetadata.partChecksum)
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join('');
                    console.log(`[Worker] Parsed part metadata: part ${chunk.partMetadata.currentPart + 1}/${chunk.partMetadata.totalParts}, checksum: ${checksumHex}`);
                }

                // Add chunk to decoder
                decoder!.addChunk(chunk);

                // Only attempt full decode check every 500ms or if new blocks were decoded
                const now = Date.now();
                const decodedBlockCount = decoder!.wasm.getDecodedBlockCount();
                const hasNewBlocks = decodedBlockCount !== lastDecodedBlockCount;
                const shouldAttemptDecode = (now - lastDecodeAttemptTime >= 500) || hasNewBlocks;

                // Check part completion if in part-based mode
                let partCompleteInfo: { partComplete: boolean; isValid: boolean; expectedChecksum: string; actualChecksum: string; currentPart: number; totalParts: number } | undefined;
                if (partBasedMode && (now - lastPartCompleteCheck >= 1000)) {
                    lastPartCompleteCheck = now;
                    if (decoder!.wasm.isCurrentPartComplete()) {
                        const partInfo = decoder!.getPartInfo();
                        const expectedChecksumBytes = expectedPartChecksumBytes.get(partInfo.currentPartIndex);

                        // Only validate if we have the expected checksum
                        if (expectedChecksumBytes) {
                            // Call Rust to validate the checksum
                            const validationResult = decoder!.wasm.validateCurrentPartChecksum(expectedChecksumBytes);

                            if (validationResult) {
                                console.log(`[Worker] Part ${partInfo.currentPartIndex + 1} complete. Expected: ${validationResult.expectedChecksum}, Actual: ${validationResult.actualChecksum}, Valid: ${validationResult.isValid}`);

                                partCompleteInfo = {
                                    partComplete: true,
                                    isValid: validationResult.isValid,
                                    expectedChecksum: validationResult.expectedChecksum,
                                    actualChecksum: validationResult.actualChecksum,
                                    currentPart: partInfo.currentPartIndex,
                                    totalParts: partInfo.totalParts
                                };

                                // If checksum matches, mark part as completed (reconstructs and stores part data, then cleans up memory)
                                if (validationResult.isValid) {
                                    decoder!.wasm.markPartCompleted(partInfo.currentPartIndex);
                                    console.log(`[Worker] Part ${partInfo.currentPartIndex + 1}/${partInfo.totalParts} completed and memory freed`);

                                    // Clean up the checksum from the map since this part is completed
                                    expectedPartChecksumBytes.delete(partInfo.currentPartIndex);

                                    // If this was the last part, force a decode check to trigger completion
                                    const isLastPart = (partInfo.currentPartIndex + 1) === partInfo.totalParts;
                                    if (isLastPart) {
                                        console.log('[Worker] Last part completed, forcing completion check...');
                                        lastDecodeAttemptTime = 0; // Force decode attempt
                                    }
                                }
                            }
                        }
                    }
                }

                if (shouldAttemptDecode) {
                    lastDecodeAttemptTime = now;
                    lastDecodedBlockCount = decodedBlockCount;

                    // Get overall progress (fraction of total blocks decoded across entire file)
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

                    // If complete, trigger reconstruction
                    // In part-based mode, this happens when all parts are stored
                    // In non-part mode, this happens when all blocks are decoded
                    if (isComplete) {
                        const reconstructedData = decoder!.getDecodedData();
                        if (reconstructedData) {
                            // Validate final checksum using Rust (avoids expensive JS computation)
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