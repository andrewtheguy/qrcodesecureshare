/// <reference lib="webworker" />

import { FountainDecoder } from '../utils/fountainCodeWasm';
import type { FountainMetadata, FountainChunk } from '../utils/fountainCodeWasm';
import { computeChecksum, type ChecksumAlgorithm } from '../utils/checksum';

/**
 * Ensures the decoder is initialized before use
 */
function ensureDecoder(): void {
    if (!decoder) {
        throw new Error('Decoder not initialized');
    }
}

/**
 * Creates a composite dedup key for chunk identification
 * Combines seed, degree, first index, and last index to prevent false positives
 * from seed rollover or long sessions
 */
function createChunkKey(chunk: { seed: number; degree: number; indices: number[] }): string {
    const firstIdx = chunk.indices.length > 0 ? chunk.indices[0] : -1;
    const lastIdx = chunk.indices.length > 0 ? chunk.indices[chunk.indices.length - 1] : -1;
    return `${chunk.seed}:${chunk.degree}:${firstIdx}:${lastIdx}`;
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
const expectedPartChecksums = new Map<number, string>(); // Per-part checksums from sender, keyed by part index
let lastPartCompleteCheck = 0; // Throttle part completion checks

/**
 * Parses binary chunk data into a FountainChunk object
 */
function parseBinaryChunk(bytes: Uint8Array): FountainChunk & { checksumStart: number; partInfo?: { currentPart: number; totalParts: number; partChecksum: string } } {
    // Check minimum length for header (magic 2, seed 2, degree 1, numIndices 1)
    if (bytes.length < 6) {
        throw new Error('Chunk too short: missing header');
    }

    // Validate magic bytes [0xFF][0xFD]
    if (bytes[0] !== 0xFF || bytes[1] !== 0xFD) {
        throw new Error('Invalid magic bytes');
    }

    // Extract seed (2 bytes, big-endian)
    const seed = (bytes[2] << 8) | bytes[3];

    // Extract degree (1 byte)
    const degree = bytes[4];

    // Extract numIndices (1 byte)
    const numIndices = bytes[5];

    // Validate numIndices
    if (numIndices < 0 || numIndices > 1000) {
        throw new Error('Invalid numIndices: ' + numIndices);
    }

    // Ensure metadata is initialized and validate against total source blocks
    if (!metadata) throw new Error('Decoder metadata not initialized');
    if (numIndices > metadata.totalSourceBlocks) throw new Error('Invalid numIndices: exceeds total source blocks');

    // Check length for indices and checksum
    const expectedMinLength = 6 + numIndices * 2 + 4;
    if (bytes.length < expectedMinLength) {
        throw new Error('Chunk too short: missing indices or checksum');
    }

    // Extract indices (2 bytes each, big-endian)
    const indices: number[] = [];
    let offset = 6;
    for (let i = 0; i < numIndices; i++) {
        if (offset + 1 >= bytes.length) {
            throw new Error('Unexpected end of data while reading indices');
        }
        const index = (bytes[offset] << 8) | bytes[offset + 1];
        indices.push(index);
        offset += 2;
    }

    // Try to parse part metadata if present
    // Part metadata format: currentPart(2) + totalParts(2) + partChecksum(4) = 8 bytes
    let partInfo: { currentPart: number; totalParts: number; partChecksum: string } | undefined;
    const remainingBytes = bytes.length - offset - 4; // Subtract 4 for final checksum

    // Check if there's at least 8 bytes for part metadata
    // (part metadata comes before chunk data)
    if (partBasedMode && remainingBytes >= 8) {
        // Extract part metadata
        const currentPart = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;

        const totalParts = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;

        // Extract part checksum (4 bytes as hex string)
        let partChecksumHex = '';
        for (let i = 0; i < 4; i++) {
            partChecksumHex += bytes[offset++].toString(16).padStart(2, '0');
        }

        partInfo = {
            currentPart,
            totalParts,
            partChecksum: partChecksumHex
        };

        // Store expected checksum for this part (indexed by part number)
        expectedPartChecksums.set(currentPart, partChecksumHex);

        console.log(`[Worker] Parsed part metadata: part ${currentPart + 1}/${totalParts}, checksum: ${partChecksumHex}`);
    }

    // Extract data (between current offset and checksum)
    const checksumStart = bytes.length - 4;
    if (checksumStart < offset) {
        throw new Error('Invalid checksum position: checksumStart < offset');
    }
    const data = bytes.slice(offset, checksumStart);

    return {
        seed,
        degree,
        indices,
        data,
        checksumStart,
        partInfo
    };
}

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
                    expectedPartChecksums.clear(); // Clear any previous part checksums
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
                const chunk = parseBinaryChunk(binaryData);

                // Check for duplicate chunk using composite key
                const chunkKey = createChunkKey(chunk);
                if (receivedChunks.has(chunkKey)) {
                    self.postMessage({ type: 'chunkProcessed', id, duplicate: true, seed: chunk.seed });
                    break;
                }

                // Validate checksum over complete chunk: seed(2) + degree(1) + numIndices(1) + indices(2N) + [partMetadata] + data
                // This is everything except magic bytes (first 2 bytes) and checksum itself (last 4 bytes)
                const checksumPayload = binaryData.slice(2, chunk.checksumStart);
                const expectedChecksumStr = Array.from(binaryData.slice(chunk.checksumStart))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                const computedChecksum = await computeChecksum(checksumPayload, 'crc32');
                const ok = computedChecksum === expectedChecksumStr;
                if (!ok) {
                    console.error(`[Worker] Checksum mismatch! Expected: ${expectedChecksumStr}, Got: ${computedChecksum}`);
                    console.error(`[Worker] Payload length: ${checksumPayload.length}, checksumStart: ${chunk.checksumStart}, total: ${binaryData.length}`);
                    console.error(`[Worker] partBasedMode: ${partBasedMode}, partInfo:`, chunk.partInfo);
                    self.postMessage({ type: 'error', id, error: 'Invalid checksum', seed: chunk.seed });
                    break;
                }

                // Add to received chunks using composite key
                receivedChunks.add(chunkKey);
                processedSeeds.add(chunk.seed);

                // Add chunk to decoder
                decoder!.addChunk(chunk);

                // Only attempt full decode check every 500ms or if new blocks were decoded
                const now = Date.now();
                const decodedBlockCount = decoder!.wasm.getDecodedBlockCount();
                const hasNewBlocks = decodedBlockCount !== lastDecodedBlockCount;
                const shouldAttemptDecode = (now - lastDecodeAttemptTime >= 500) || hasNewBlocks;

                // Check part completion if in part-based mode
                let partCompleteInfo: { partComplete: boolean; partChecksumMatch: boolean; computedChecksum: string; currentPart: number; totalParts: number } | undefined;
                if (partBasedMode && (now - lastPartCompleteCheck >= 1000)) {
                    lastPartCompleteCheck = now;
                    if (decoder!.wasm.isCurrentPartComplete()) {
                        const partData = decoder!.wasm.getCurrentPartData();
                        if (partData) {
                            const computedChecksum = await computeChecksum(partData, 'crc32');
                            const partInfo = decoder!.getPartInfo();
                            const expectedChecksum = expectedPartChecksums.get(partInfo.currentPartIndex) || '';
                            const checksumMatch = computedChecksum === expectedChecksum;

                            console.log(`[Worker] Part ${partInfo.currentPartIndex + 1} complete. Computed checksum: ${computedChecksum}, Expected: ${expectedChecksum}, Match: ${checksumMatch}`);

                            partCompleteInfo = {
                                partComplete: true,
                                partChecksumMatch: checksumMatch,
                                computedChecksum,
                                currentPart: partInfo.currentPartIndex,
                                totalParts: partInfo.totalParts
                            };

                            // If checksum matches, mark part as completed (reconstructs and stores part data, then cleans up memory)
                            if (checksumMatch) {
                                decoder!.wasm.markPartCompleted(partInfo.currentPartIndex);
                                console.log(`[Worker] Part ${partInfo.currentPartIndex + 1}/${partInfo.totalParts} completed and memory freed`);

                                // Clean up the checksum from the map since this part is completed
                                expectedPartChecksums.delete(partInfo.currentPartIndex);

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

                if (shouldAttemptDecode) {
                    lastDecodeAttemptTime = now;
                    lastDecodedBlockCount = decodedBlockCount;

                    // Get overall progress (fraction of total blocks decoded across entire file)
                    const overallProgress = decoder!.wasm.getProgress();
                    const isComplete = decoder!.isComplete();
                    const decodedBlockIndices = decoder!.wasm.getDecodedBlockIndices();

                    // Get part-specific progress
                    let partProgress = calculatePartProgress(decoder!, partBasedMode);
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
                            const computed = await computeChecksum(reconstructedData, metadata.checksumAlg as ChecksumAlgorithm || 'crc32');
                            const integrityOk = computed === metadata.checksum;
                            self.postMessage({
                                type: 'complete',
                                id,
                                data: reconstructedData,
                                integrityOk,
                                expectedChecksum: metadata.checksum,
                                calculatedChecksum: computed
                            }, [reconstructedData.buffer]);
                        }
                    }
                } else {
                    // Queue chunk and send current state without full decode check
                    const overallProgress = decoder!.wasm.getProgress();
                    const decodedBlockIndices = decoder!.wasm.getDecodedBlockIndices();

                    // Get part-specific info
                    let partProgress = calculatePartProgress(decoder!, partBasedMode);
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