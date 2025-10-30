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
import { FountainWasmEncoder, FountainWasmDecoder, type WasmFountainMetadata } from './fountainCodeWasm'
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

  private constructor(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ) {
    // Create JS encoder for coordination logic only
    this.jsEncoder = new JSFountainEncoder(data, metadata, opts)

    // Note: wasmEncoder is set by the static create method
    this.wasmEncoder = null as unknown as FountainWasmEncoder
  }

  /**
   * Create a new encoder (ensures WASM is initialized first)
   */
  static async create(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ): Promise<FountainEncoder> {
    const encoder = new FountainEncoder(data, metadata, opts)

    // Runtime assertion: verify required fields before WASM call
    if (!metadata.name || typeof metadata.name !== 'string') {
      throw new Error('metadata.name is required and must be a string')
    }
    if (!metadata.type || typeof metadata.type !== 'string') {
      throw new Error('metadata.type is required and must be a string')
    }
    if (metadata.timestamp !== undefined && typeof metadata.timestamp !== 'number') {
      throw new Error('metadata.timestamp must be a number if provided')
    }

    // Assemble explicit WASM-bound metadata shape
    const wasmMetadata = {
      name: metadata.name,
      type: metadata.type,
      timestamp: metadata.timestamp ?? Date.now()
    }

    // Create WASM encoder for computation (REQUIRED)
    try {
      encoder.wasmEncoder = await FountainWasmEncoder.create(
        data,
        wasmMetadata,
        {
          blockSize: opts.blockSize,
          c: opts.c,
          delta: opts.delta,
          seedOffset: opts.seedOffset,
          fixedOverhead: opts.fixedOverhead,
          partOverhead: opts.partOverhead,
          maxDegree: opts.maxDegree,
          degree1Rate: opts.degree1Rate,
          lowDegreeRate: opts.lowDegreeRate,
          maxQRDataSize: opts.maxQRDataSize
        }
      )
    } catch (err) {
      // Check if this is a WASM initialization failure
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (errorMessage.includes('WASM_INIT_FAILED')) {
        // Rethrow with distinct identifier preserved
        throw new Error(`WASM_INIT_FAILED: ${errorMessage}`)
      }
      throw new Error(`Failed to initialize WASM encoder: ${errorMessage}. WASM is required for fountain code operations.`)
    }

    return encoder
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
 * REQUIRES WASM for computation (including part-based mode), uses JavaScript for coordination
 */
export class FountainDecoder {
  private jsDecoder: JSFountainDecoder
  private wasmDecoder: FountainWasmDecoder
  private metadata: FountainMetadata

  private constructor(
    metadata: FountainMetadata,
    partBasedMode: boolean = false,
    partSize: number = 0
  ) {
    this.metadata = metadata

    // Always create JS decoder for coordination
    this.jsDecoder = new JSFountainDecoder(metadata, partBasedMode, partSize)

    // Note: wasmDecoder is set by the static create method
    this.wasmDecoder = null as unknown as FountainWasmDecoder
  }

  /**
   * Create a new decoder (ensures WASM is initialized first)
   */
  static async create(
    metadata: FountainMetadata,
    partBasedMode: boolean = false,
    partSize: number = 0
  ): Promise<FountainDecoder> {
    const decoder = new FountainDecoder(metadata, partBasedMode, partSize)

    // Runtime assertion: verify required fields before WASM call
    if (!metadata.name || typeof metadata.name !== 'string') {
      throw new Error('metadata.name is required and must be a string')
    }
    if (typeof metadata.size !== 'number' || metadata.size < 0) {
      throw new Error('metadata.size is required and must be a non-negative number')
    }
    if (!metadata.type || typeof metadata.type !== 'string') {
      throw new Error('metadata.type is required and must be a string')
    }
    if (typeof metadata.timestamp !== 'number') {
      throw new Error('metadata.timestamp is required and must be a number')
    }
    if (typeof metadata.totalSourceBlocks !== 'number' || metadata.totalSourceBlocks <= 0) {
      throw new Error('metadata.totalSourceBlocks is required and must be a positive number')
    }
    if (typeof metadata.blockSize !== 'number' || metadata.blockSize <= 0) {
      throw new Error('metadata.blockSize is required and must be a positive number')
    }

    // Assemble explicit WASM-bound metadata shape
    const wasmMetadata: WasmFountainMetadata = {
      name: metadata.name,
      size: metadata.size,
      fileType: metadata.type,
      timestamp: metadata.timestamp,
      totalSourceBlocks: metadata.totalSourceBlocks,
      blockSize: metadata.blockSize,
    }

    // Create WASM decoder for computation (required for both regular and part-based mode)
    try {
      decoder.wasmDecoder = await FountainWasmDecoder.create(
        wasmMetadata,
        partBasedMode,
        partSize
      )
    } catch (err) {
      // Check if this is a WASM initialization failure
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (errorMessage.includes('WASM_INIT_FAILED')) {
        // Rethrow with distinct identifier preserved
        throw new Error(`WASM_INIT_FAILED: ${errorMessage}`)
      }
      throw new Error(`Failed to initialize WASM decoder: ${errorMessage}. WASM is required for fountain code operations.`)
    }

    return decoder
  }

  /**
   * Add a chunk and decode (REQUIRES WASM)
   */
  addChunk(chunk: FountainChunk): boolean {
    // Add to both decoders (WASM for computation, JS for coordination)
    this.jsDecoder.addChunk(chunk)
    return this.wasmDecoder.addChunk(chunk)
  }

  /**
   * Get decoded data (REQUIRES WASM)
   */
  getDecodedData(): Uint8Array | null {
    return this.wasmDecoder.getDecodedData()
  }

  /**
   * Get overall decode progress (REQUIRES WASM)
   * Returns the fraction (0.0 to 1.0) of total blocks decoded across the entire file.
   * In part-based mode, this represents overall file progress, not current part progress.
   * Use getCurrentPartDecodedBlockCount() / getCurrentPartTotalBlockCount() for part-specific progress.
   */
  getProgress(): number {
    return this.wasmDecoder.getProgress()
  }

  /**
   * Check if complete (REQUIRES WASM)
   */
  isComplete(): boolean {
    return this.wasmDecoder.isComplete()
  }

  getReceivedChunkCount(): number {
    return this.wasmDecoder.getReceivedChunkCount()
  }

  getDecodedBlockCount(): number {
    return this.wasmDecoder.getDecodedBlockCount()
  }

  getDecodedBlockIndices(): number[] {
    return this.wasmDecoder.getDecodedBlockIndices()
  }

  // ========================================
  // Part-based mode methods (use WASM)
  // ========================================

  isCurrentPartComplete(): boolean {
    return this.wasmDecoder.isCurrentPartComplete()
  }

  getCurrentPartData(): Uint8Array | null {
    return this.wasmDecoder.getCurrentPartData()
  }

  getPartInfo() {
    return this.wasmDecoder.getPartInfo()
  }

  moveToNextPart(): boolean {
    // Update both decoders for coordination
    this.jsDecoder.moveToNextPart()
    return this.wasmDecoder.moveToNextPart()
  }

  markPartCompleted(partIndex: number): void {
    // Update both decoders for coordination
    this.jsDecoder.markPartCompleted(partIndex)
    this.wasmDecoder.markPartCompleted(partIndex)
  }

  getCurrentPartDecodedBlockCount(): number {
    return this.wasmDecoder.getCurrentPartDecodedBlockCount()
  }

  getCurrentPartTotalBlockCount(): number {
    return this.wasmDecoder.getCurrentPartTotalBlockCount()
  }

  getMetadata(): FountainMetadata {
    // Get metadata from JS decoder (has all fields including checksum and checksumAlg)
    return this.jsDecoder.getMetadata()
  }

  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    return this.jsDecoder.getContiguousBlocksData(startIdx, endIdx)
  }
}

// Re-export types for convenience
export type { FountainChunk, FountainMetadata, FountainEncoderOptions }
