/**
 * Hybrid Fountain Code Implementation
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
 * Hybrid Fountain Encoder
 * Delegates computation-heavy chunk generation to WASM,
 * keeps coordination logic in JavaScript
 */
export class FountainEncoder {
  private jsEncoder: JSFountainEncoder
  private wasmEncoder: FountainWasmEncoder | null = null
  private useWasm: boolean

  constructor(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ) {
    // Always create JS encoder for coordination
    this.jsEncoder = new JSFountainEncoder(data, metadata, opts)

    // Try to create WASM encoder for computation
    this.useWasm = true
    try {
      this.wasmEncoder = new FountainWasmEncoder(
        data,
        { name: metadata.name, type: metadata.type, timestamp: metadata.timestamp },
        { blockSize: opts.blockSize, c: opts.c, delta: opts.delta }
      )
    } catch (err) {
      console.warn('Failed to initialize WASM encoder, falling back to JavaScript:', err)
      this.useWasm = false
    }
  }

  /**
   * Generate a fountain chunk (COMPUTATION-HEAVY - uses WASM)
   */
  generateChunk(): FountainChunk {
    if (this.useWasm && this.wasmEncoder) {
      try {
        return this.wasmEncoder.generateChunk()
      } catch (err) {
        console.warn('WASM generateChunk failed, falling back to JS:', err)
        this.useWasm = false
      }
    }
    return this.jsEncoder.generateChunk()
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
 * Hybrid Fountain Decoder
 * Delegates computation-heavy belief propagation to WASM,
 * keeps coordination logic in JavaScript
 */
export class FountainDecoder {
  private jsDecoder: JSFountainDecoder
  private wasmDecoder: FountainWasmDecoder | null = null
  private useWasm: boolean
  private metadata: FountainMetadata

  constructor(
    metadata: FountainMetadata,
    partBasedMode: boolean = false,
    partSize: number = 0
  ) {
    this.metadata = metadata

    // Always create JS decoder for coordination
    this.jsDecoder = new JSFountainDecoder(metadata, partBasedMode, partSize)

    // Only use WASM if NOT in part-based mode (WASM doesn't support it yet)
    this.useWasm = !partBasedMode

    if (this.useWasm) {
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
        console.warn('Failed to initialize WASM decoder, falling back to JavaScript:', err)
        this.useWasm = false
      }
    }
  }

  /**
   * Add a chunk and decode (COMPUTATION-HEAVY - uses WASM when possible)
   */
  addChunk(chunk: FountainChunk): boolean {
    // Always add to JS decoder for coordination
    const jsResult = this.jsDecoder.addChunk(chunk)

    // Also add to WASM decoder if available
    if (this.useWasm && this.wasmDecoder) {
      try {
        this.wasmDecoder.addChunk(chunk)
      } catch (err) {
        console.warn('WASM addChunk failed, falling back to JS:', err)
        this.useWasm = false
      }
    }

    return jsResult
  }

  /**
   * Get decoded data (COMPUTATION-HEAVY - uses WASM when possible)
   */
  getDecodedData(): Uint8Array | null {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.getDecodedData()
      } catch (err) {
        console.warn('WASM getDecodedData failed, falling back to JS:', err)
        this.useWasm = false
      }
    }
    return this.jsDecoder.getDecodedData()
  }

  /**
   * Get progress (uses WASM when available for consistency)
   */
  getProgress(): number {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.getProgress()
      } catch (err) {
        console.warn('WASM getProgress failed, falling back to JS:', err)
        this.useWasm = false
      }
    }
    return this.jsDecoder.getProgress()
  }

  /**
   * Check if complete (uses WASM when available for consistency)
   */
  isComplete(): boolean {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.isComplete()
      } catch (err) {
        console.warn('WASM isComplete failed, falling back to JS:', err)
        this.useWasm = false
      }
    }
    return this.jsDecoder.isComplete()
  }

  getReceivedChunkCount(): number {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.getReceivedChunkCount()
      } catch {
        this.useWasm = false
      }
    }
    return this.jsDecoder.getReceivedChunkCount()
  }

  getDecodedBlockCount(): number {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.getDecodedBlockCount()
      } catch {
        this.useWasm = false
      }
    }
    return this.jsDecoder.getDecodedBlockCount()
  }

  getDecodedBlockIndices(): number[] {
    if (this.useWasm && this.wasmDecoder) {
      try {
        return this.wasmDecoder.getDecodedBlockIndices()
      } catch {
        this.useWasm = false
      }
    }
    return this.jsDecoder.getDecodedBlockIndices()
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
