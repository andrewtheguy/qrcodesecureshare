/**
 * WASM-Required Fountain Code Implementation
 *
 * Uses Rust WASM for computation-heavy operations:
 * - generateChunk() - Chunk generation with XOR operations
 * - addChunk() - Belief propagation decoding
 * - getDecodedData() - Block reassembly
 *
 * Uses JavaScript for coordination logic:
 * - Part-based mode management
 * - Targeted encoding mode
 * - Statistics tracking
 * - Checksum computation (already uses hash-wasm)
 */

import { FountainEncoder as JSFountainEncoder, FountainDecoder as JSFountainDecoder } from './fountainCode'
import { FountainWasmEncoder, FountainWasmDecoder } from './fountainCodeWasm'
import type {
  FountainChunk,
  FountainMetadata,
  FountainEncoderOptions,
} from './fountainCode'

/**
 * Fountain Encoder
 * REQUIRES WASM for computation, uses JavaScript for coordination
 */
export class FountainEncoder {
  private jsEncoder: JSFountainEncoder
  private wasmEncoder: FountainWasmEncoder

  constructor(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ) {
    // Create JS encoder for coordination logic only
    this.jsEncoder = new JSFountainEncoder(data, metadata, opts)

    // Create WASM encoder for computation (REQUIRED)
    try {
      this.wasmEncoder = new FountainWasmEncoder(
        data,
        { name: metadata.name, type: metadata.type, timestamp: metadata.timestamp },
        { blockSize: opts.blockSize, c: opts.c, delta: opts.delta }
      )
    } catch (err) {
      throw new Error(`Failed to initialize WASM encoder: ${err instanceof Error ? err.message : String(err)}. WASM is required for fountain code operations.`)
    }
  }

  /**
   * Generate a fountain chunk (REQUIRES WASM)
   */
  generateChunk(): FountainChunk {
    return this.wasmEncoder.generateChunk()
  }

  /**
   * Generate multiple chunks at once
   */
  generateChunks(count: number): FountainChunk[] {
    return Array.from({ length: count }, () => this.generateChunk())
  }

  // ========================================
  // Coordination methods (use JavaScript)
  // ========================================

  async computePartChecksums(): Promise<void> {
    return this.jsEncoder.computePartChecksums()
  }

  getPartInfo() {
    return this.jsEncoder.getPartInfo()
  }

  moveToNextPart(): boolean {
    return this.jsEncoder.moveToNextPart()
  }

  markPartCompleted(partIndex: number): void {
    return this.jsEncoder.markPartCompleted(partIndex)
  }

  setReceivedBlocks(blockIndices: number[]): void {
    return this.jsEncoder.setReceivedBlocks(blockIndices)
  }

  setMissingBlocks(blockIndices: number[]): void {
    return this.jsEncoder.setMissingBlocks(blockIndices)
  }

  getMetadata(): FountainMetadata {
    return this.jsEncoder.getMetadata()
  }

  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    return this.jsEncoder.getContiguousBlocksData(startIdx, endIdx)
  }
}

/**
 * Fountain Decoder
 * REQUIRES WASM for computation (except part-based mode), uses JavaScript for coordination
 */
export class FountainDecoder {
  private jsDecoder: JSFountainDecoder
  private wasmDecoder: FountainWasmDecoder | null = null
  private partBasedMode: boolean
  private metadata: FountainMetadata

  constructor(
    metadata: FountainMetadata,
    partBasedMode: boolean = false,
    partSize: number = 0
  ) {
    this.metadata = metadata
    this.partBasedMode = partBasedMode

    // Always create JS decoder for coordination
    this.jsDecoder = new JSFountainDecoder(metadata, partBasedMode, partSize)

    // WASM doesn't support part-based mode yet, so only use it for regular mode
    if (!partBasedMode) {
      try {
        this.wasmDecoder = new FountainWasmDecoder({
          name: metadata.name,
          size: metadata.size,
          fileType: metadata.type,
          timestamp: metadata.timestamp,
          totalSourceBlocks: metadata.totalSourceBlocks,
          blockSize: metadata.blockSize,
        })
      } catch (err) {
        throw new Error(`Failed to initialize WASM decoder: ${err instanceof Error ? err.message : String(err)}. WASM is required for fountain code operations.`)
      }
    }
  }

  /**
   * Add a chunk and decode (REQUIRES WASM in regular mode, uses JS in part-based mode)
   */
  addChunk(chunk: FountainChunk): boolean {
    if (this.partBasedMode) {
      // Part-based mode uses JS decoder
      return this.jsDecoder.addChunk(chunk)
    }

    // Regular mode requires WASM
    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    // Add to both decoders for coordination
    this.jsDecoder.addChunk(chunk)
    return this.wasmDecoder.addChunk(chunk)
  }

  /**
   * Get decoded data (REQUIRES WASM in regular mode, uses JS in part-based mode)
   */
  getDecodedData(): Uint8Array | null {
    if (this.partBasedMode) {
      return this.jsDecoder.getDecodedData()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.getDecodedData()
  }

  /**
   * Get progress (REQUIRES WASM in regular mode, uses JS in part-based mode)
   */
  getProgress(): number {
    if (this.partBasedMode) {
      return this.jsDecoder.getProgress()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.getProgress()
  }

  /**
   * Check if complete (REQUIRES WASM in regular mode, uses JS in part-based mode)
   */
  isComplete(): boolean {
    if (this.partBasedMode) {
      return this.jsDecoder.isComplete()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.isComplete()
  }

  getReceivedChunkCount(): number {
    if (this.partBasedMode) {
      return this.jsDecoder.getReceivedChunkCount()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.getReceivedChunkCount()
  }

  getDecodedBlockCount(): number {
    if (this.partBasedMode) {
      return this.jsDecoder.getDecodedBlockCount()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.getDecodedBlockCount()
  }

  getDecodedBlockIndices(): number[] {
    if (this.partBasedMode) {
      return this.jsDecoder.getDecodedBlockIndices()
    }

    if (!this.wasmDecoder) {
      throw new Error('WASM decoder not initialized')
    }

    return this.wasmDecoder.getDecodedBlockIndices()
  }

  // ========================================
  // Coordination methods (use JavaScript)
  // ========================================

  isCurrentPartComplete(): boolean {
    return this.jsDecoder.isCurrentPartComplete()
  }

  getCurrentPartData(): Uint8Array | null {
    return this.jsDecoder.getCurrentPartData()
  }

  getPartInfo() {
    return this.jsDecoder.getPartInfo()
  }

  moveToNextPart(): boolean {
    return this.jsDecoder.moveToNextPart()
  }

  markPartCompleted(partIndex: number): void {
    return this.jsDecoder.markPartCompleted(partIndex)
  }

  getCurrentPartDecodedBlockCount(): number {
    return this.jsDecoder.getCurrentPartDecodedBlockCount()
  }

  getCurrentPartTotalBlockCount(): number {
    return this.jsDecoder.getCurrentPartTotalBlockCount()
  }

  getMetadata(): FountainMetadata {
    return this.jsDecoder.getMetadata()
  }

  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    return this.jsDecoder.getContiguousBlocksData(startIdx, endIdx)
  }
}

// Re-export types for convenience
export type { FountainChunk, FountainMetadata, FountainEncoderOptions }
