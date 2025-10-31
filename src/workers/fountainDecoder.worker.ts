/// <reference lib="webworker" />

import { FountainDecoder } from '../utils/fountainCodeWasm';
import type { FountainMetadata } from '../utils/fountainCodeWasm';

/**
 * Result types from Rust processBinaryChunk method
 */
interface BinaryChunkProcessResult {
    type: 'processed' | 'duplicate' | 'parseError' | 'checksumError' | 'processingError';
    message?: string; // Present for error types
    seed: number;
    decodedBlockCount: number;
    overallProgress: number;
    partProgress: number;
    isComplete: boolean;
    decodedBlockIndices: number[];
    currentPartIndex?: number;
    totalParts?: number;
    currentPartDecodedBlocks?: number;
    currentPartTotalBlocks?: number;
    partCompleteInfo?: {
        isValid: boolean;
        expectedChecksum: string;
        actualChecksum: string;
        currentPart: number;
        totalParts: number;
    };
    completionData?: {
        data: Uint8Array;
        integrityOk: boolean;
        expectedChecksum: string;
        actualChecksum: string;
    };
}

// Worker state
let decoder: FountainDecoder | null = null;
let metadata: FountainMetadata;
let currentSessionId: number | null = null;
let partBasedMode = false;
let partSize = 0;

/**
 * Ensures the decoder is initialized before use
 */
function ensureDecoder(): void {
    if (!decoder) {
        throw new Error('Decoder not initialized');
    }
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

                // Track session changes
                if (sessionId !== undefined && sessionId !== currentSessionId) {
                    console.log(`[Worker] Session changed from ${currentSessionId} to ${sessionId}`);
                    currentSessionId = sessionId;
                } else if (!currentSessionId) {
                    currentSessionId = sessionId ?? null;
                }

                console.log(`[Worker] Initialized with sessionId: ${sessionId}, partBasedMode: ${partBasedMode}, partSize: ${partSize}`);

                try {
                    decoder = await FountainDecoder.create(metadata, partBasedMode, partSize);

                    // Set session ID (clears dedup cache on session change)
                    if (sessionId !== undefined) {
                        decoder.wasm.setSessionId(sessionId);
                    }

                    // Set final checksum for integrity validation
                    decoder.wasm.setFinalChecksum(metadata.checksum);

                    self.postMessage({ type: 'initialized', id, metadata });
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    if (errorMessage.includes('WASM_INIT_FAILED')) {
                        self.postMessage({
                            type: 'error',
                            id,
                            code: 'WASM_INIT_FAILED',
                            error: 'Failed to initialize WASM decoder. Please refresh and try again.',
                            details: errorMessage
                        });
                    } else {
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

                // Process binary chunk through complete Rust pipeline
                let result: BinaryChunkProcessResult;
                try {
                    // Check if method exists
                    if (typeof decoder!.wasm.processBinaryChunk !== 'function') {
                        console.error('[Worker] processBinaryChunk method not found! WASM may not be updated. Available methods:', Object.keys(decoder!.wasm));
                        self.postMessage({ type: 'error', id, error: 'processBinaryChunk method not found - please hard refresh (Ctrl+Shift+R or Cmd+Shift+R)' });
                        break;
                    }

                    const rawResult = decoder!.wasm.processBinaryChunk(binaryData);

                    console.log('[Worker] rawResult type:', rawResult instanceof Map ? 'Map' : typeof rawResult);
                    console.log('[Worker] rawResult:', rawResult);

                    // WASM returns a Map due to serde flatten - convert to plain object
                    if (rawResult instanceof Map) {
                        result = Object.fromEntries(rawResult) as BinaryChunkProcessResult;

                        console.log('[Worker] After top-level conversion, completionData type:',
                            result.completionData instanceof Map ? 'Map' : typeof result.completionData);
                        console.log('[Worker] completionData value:', result.completionData);

                        // Convert nested Maps to objects as well
                        if (result.completionData instanceof Map) {
                            console.log('[Worker] Converting completionData Map to object');
                            result.completionData = Object.fromEntries(result.completionData) as BinaryChunkProcessResult['completionData'];
                            console.log('[Worker] After conversion:', result.completionData);
                        }
                        if (result.partCompleteInfo instanceof Map) {
                            console.log('[Worker] Converting partCompleteInfo Map to object');
                            result.partCompleteInfo = Object.fromEntries(result.partCompleteInfo) as BinaryChunkProcessResult['partCompleteInfo'];
                        }
                    } else {
                        result = rawResult as unknown as BinaryChunkProcessResult;
                    }

                    console.log('[Worker] processBinaryChunk result:', {
                        type: result.type,
                        seed: result.seed,
                        decodedBlockCount: result.decodedBlockCount,
                        overallProgress: result.overallProgress,
                        isComplete: result.isComplete,
                        decodedBlockIndices: result.decodedBlockIndices?.length
                    });

                    // Validate result has expected fields
                    if (result.decodedBlockCount === undefined || result.overallProgress === undefined) {
                        console.error('[Worker] Result missing expected fields! Result:', result);
                        self.postMessage({ type: 'error', id, error: 'Invalid result from WASM - missing fields' });
                        break;
                    }
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    console.error('[Worker] processBinaryChunk error:', err);
                    self.postMessage({ type: 'error', id, error: `Processing error: ${errorMessage}` });
                    break;
                }

                // Handle different result types
                if (result.type === 'parseError' || result.type === 'checksumError' || result.type === 'processingError') {
                    self.postMessage({
                        type: 'error',
                        id,
                        error: `${result.type}: ${result.message || 'Unknown error'}`,
                        seed: result.seed
                    });
                    break;
                }

                if (result.type === 'duplicate') {
                    // Even for duplicates, send current progress so UI stays updated
                    self.postMessage({
                        type: 'chunkProcessed',
                        id,
                        duplicate: true,
                        seed: result.seed,
                        decodedBlockCount: result.decodedBlockCount,
                        overallProgress: result.overallProgress,
                        partProgress: result.partProgress,
                        isComplete: result.isComplete,
                        decodedBlockIndices: result.decodedBlockIndices,
                        currentPartDecodedBlocks: result.currentPartDecodedBlocks,
                        currentPartTotalBlocks: result.currentPartTotalBlocks,
                        currentPartIndex: result.currentPartIndex,
                        totalParts: result.totalParts
                    });
                    break;
                }

                // Handle successful processing
                const partCompleteInfo = result.partCompleteInfo ? {
                    partComplete: true,
                    isValid: result.partCompleteInfo.isValid,
                    expectedChecksum: result.partCompleteInfo.expectedChecksum,
                    actualChecksum: result.partCompleteInfo.actualChecksum,
                    currentPart: result.partCompleteInfo.currentPart,
                    totalParts: result.partCompleteInfo.totalParts
                } : undefined;

                if (partCompleteInfo?.isValid) {
                    console.log(`[Worker] Part ${partCompleteInfo.currentPart + 1}/${partCompleteInfo.totalParts} complete and valid`);
                }

                // Send progress update
                self.postMessage({
                    type: 'chunkProcessed',
                    id,
                    seed: result.seed,
                    decodedBlockCount: result.decodedBlockCount,
                    overallProgress: result.overallProgress,
                    partProgress: result.partProgress,
                    isComplete: result.isComplete,
                    decodedBlockIndices: result.decodedBlockIndices,
                    currentPartDecodedBlocks: result.currentPartDecodedBlocks,
                    currentPartTotalBlocks: result.currentPartTotalBlocks,
                    currentPartIndex: result.currentPartIndex,
                    totalParts: result.totalParts,
                    partCompleteInfo
                });

                // If complete, send completion message
                if (result.isComplete && result.completionData) {
                    console.log('[Worker] Transfer complete! Preparing completion message');
                    console.log('[Worker] completionData:', result.completionData);

                    // Get the decoded data separately (data field is skipped in serialization)
                    const decodedData = decoder!.wasm.getDecodedData();
                    if (!decodedData) {
                        console.error('[Worker] Completion detected but no decoded data available!');
                        self.postMessage({ type: 'error', id, error: 'Transfer complete but data is missing' });
                        break;
                    }

                    console.log('[Worker] Decoded data retrieved, size:', decodedData.length, 'bytes');

                    self.postMessage({
                        type: 'complete',
                        id,
                        data: decodedData,
                        integrityOk: result.completionData.integrityOk,
                        expectedChecksum: result.completionData.expectedChecksum,
                        calculatedChecksum: result.completionData.actualChecksum
                    }, [decodedData.buffer]);
                }
                break;
            }

            case 'getStatus': {
                ensureDecoder();
                const decodedBlockCount = decoder!.wasm.getDecodedBlockCount();
                const overallProgress = decoder!.wasm.getProgress();
                const isComplete = decoder!.isComplete();
                const decodedBlockIndices = decoder!.wasm.getDecodedBlockIndices();

                // Calculate part progress
                const partProgress = partBasedMode
                    ? (decoder!.wasm.getCurrentPartTotalBlockCount() > 0
                        ? decoder!.wasm.getCurrentPartDecodedBlockCount() / decoder!.wasm.getCurrentPartTotalBlockCount()
                        : 0)
                    : overallProgress;

                self.postMessage({
                    type: 'status',
                    id,
                    decodedBlockCount,
                    overallProgress,
                    partProgress,
                    isComplete,
                    decodedBlockIndices
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
