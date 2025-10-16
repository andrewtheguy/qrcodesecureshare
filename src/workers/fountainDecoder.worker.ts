/// <reference lib="webworker" />

import { FountainDecoder } from '../utils/fountainCode';
import type { FountainMetadata, FountainChunk } from '../utils/fountainCode';
import { computeChecksum, type ChecksumAlgorithm } from '../utils/checksum';

/**
 * Ensures the decoder is initialized before use
 */
function ensureDecoder(): void {
    if (!decoder) {
        throw new Error('Decoder not initialized');
    }
}

// Worker state
let decoder: FountainDecoder | null = null;
let receivedSeeds: Set<number> = new Set();
const processedSeeds: Set<number> = new Set();
let metadata: FountainMetadata | null = null;

/**
 * Parses binary chunk data into a FountainChunk object
 */
function parseBinaryChunk(bytes: Uint8Array): FountainChunk & { checksumStart: number } {
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

    // Extract data (between indices and checksum)
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
        checksumStart
    };
}

// Message handler
self.onmessage = async (event: MessageEvent) => {
    const { type, id, ...data } = event.data;

    try {
        switch (type) {
            case 'initialize': {
                metadata = data.metadata as FountainMetadata;
                decoder = new FountainDecoder(metadata);
                receivedSeeds = new Set();
                self.postMessage({ type: 'initialized', id, metadata });
                break;
            }

            case 'processChunk': {
                ensureDecoder();
                const { binaryData } = data as { binaryData: Uint8Array };
                const chunk = parseBinaryChunk(binaryData);

                // Check for duplicate seed
                if (receivedSeeds.has(chunk.seed)) {
                    self.postMessage({ type: 'chunkProcessed', id, duplicate: true, seed: chunk.seed });
                    break;
                }

                // Validate checksum over complete chunk: seed(2) + degree(1) + numIndices(1) + indices(2N) + data
                // This is everything except magic bytes (first 2 bytes) and checksum itself (last 4 bytes)
                const checksumPayload = binaryData.slice(2, chunk.checksumStart);
                const expectedChecksumStr = Array.from(binaryData.slice(chunk.checksumStart))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                const ok = (await computeChecksum(checksumPayload, 'crc32')) === expectedChecksumStr;
                if (!ok) {
                    self.postMessage({ type: 'error', id, error: 'Invalid checksum', seed: chunk.seed });
                    break;
                }

                // Add to received seeds
                receivedSeeds.add(chunk.seed);
                processedSeeds.add(chunk.seed);

                // Add chunk to decoder
                decoder!.addChunk(chunk);

                // Get progress
                const decodedBlockCount = decoder!.getDecodedBlockCount();
                const progress = decoder!.getProgress();
                const isComplete = decoder!.isComplete();
                const decodedBlockIndices = decoder!.getDecodedBlockIndices();

                self.postMessage({
                    type: 'chunkProcessed',
                    id,
                    seed: chunk.seed,
                    decodedBlockCount,
                    progress,
                    isComplete,
                    decodedBlockIndices
                });

                // If complete, trigger reconstruction
                if (isComplete) {
                    const reconstructedData = decoder!.getDecodedData();
                    if (reconstructedData) {
                        if (metadata?.checksum) {
                            const computed = await computeChecksum(reconstructedData, metadata.checksumAlg as ChecksumAlgorithm || 'crc32');
                            const integrityOk = computed === metadata.checksum;
                            self.postMessage({
                                type: 'complete',
                                id,
                                data: reconstructedData,
                                integrityOk,
                                checksum: metadata.checksum
                            }, [reconstructedData.buffer]);
                        } else {
                            self.postMessage({ type: 'complete', id, data: reconstructedData }, [reconstructedData.buffer]);
                        }
                    }
                }
                break;
            }

            case 'reconstructFile': {
                ensureDecoder();
                const { expectedChecksum: expectedChecksumStr, checksumAlg } = data as { expectedChecksum?: string; checksumAlg?: string };
                const reconstructedData = decoder!.getDecodedData();
                if (!reconstructedData) {
                    self.postMessage({ type: 'error', id, error: 'No decoded data available' });
                    break;
                }

                if (expectedChecksumStr) {
                    const computed = await computeChecksum(reconstructedData, checksumAlg as ChecksumAlgorithm || 'crc32');
                    const integrityOk = computed === expectedChecksumStr;
                    self.postMessage({
                        type: 'complete',
                        id,
                        data: reconstructedData,
                        integrityOk,
                        checksum: expectedChecksumStr
                    }, [reconstructedData.buffer]);
                } else {
                    self.postMessage({
                        type: 'complete',
                        id,
                        data: reconstructedData
                    }, [reconstructedData.buffer]);
                }
                break;
            }


            case 'getStatus': {
                ensureDecoder();
                const decodedBlockCount__ = decoder!.getDecodedBlockCount();
                const progress_ = decoder!.getProgress();
                const isComplete_ = decoder!.isComplete();
                const decodedBlockIndices__ = decoder!.getDecodedBlockIndices();

                self.postMessage({
                    type: 'status',
                    id,
                    decodedBlockCount: decodedBlockCount__,
                    progress: progress_,
                    isComplete: isComplete_,
                    decodedBlockIndices: decodedBlockIndices__
                });
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