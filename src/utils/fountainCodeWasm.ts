import { WasmFountainEncoder, WasmFountainDecoder } from '../../rust/fountain-wasm/pkg/fountain_wasm'

// Re-export types for convenience
export interface FountainChunk {
  seed: number
  degree: number
  indices: number[]
  data: Uint8Array
}

export interface FountainMetadata {
  name: string
  size: number
  fileType: string
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
}

export interface FountainEncoderOptions {
  blockSize?: number
  c?: number
  delta?: number
}

/**
 * TypeScript wrapper for Rust WASM Fountain Encoder
 */
export class FountainWasmEncoder {
  private wasmEncoder: WasmFountainEncoder

  constructor(
    data: Uint8Array,
    metadata: { name: string; type: string; timestamp?: number },
    options?: FountainEncoderOptions
  ) {
    this.wasmEncoder = new WasmFountainEncoder(
      data,
      metadata.name,
      metadata.type,
      metadata.timestamp || Date.now(),
      options?.blockSize,
      options?.c,
      options?.delta
    )
  }

  /**
   * Generate a single fountain chunk
   */
  generateChunk(): FountainChunk {
    return this.wasmEncoder.generateChunk() as FountainChunk
  }

  /**
   * Get metadata about the encoding
   */
  getMetadata(): FountainMetadata {
    return this.wasmEncoder.getMetadata() as FountainMetadata
  }

  /**
   * Get the number of source blocks
   */
  blockCount(): number {
    return this.wasmEncoder.blockCount()
  }

  /**
   * Get the block size
   */
  blockSize(): number {
    return this.wasmEncoder.blockSize()
  }
}

/**
 * TypeScript wrapper for Rust WASM Fountain Decoder
 */
export class FountainWasmDecoder {
  private wasmDecoder: WasmFountainDecoder

  constructor(metadata: FountainMetadata) {
    this.wasmDecoder = new WasmFountainDecoder(metadata)
  }

  /**
   * Add a chunk and attempt to decode
   * Returns true if any new blocks were decoded
   */
  addChunk(chunk: FountainChunk): boolean {
    return this.wasmDecoder.addChunk(chunk)
  }

  /**
   * Check if decoding is complete
   */
  isComplete(): boolean {
    return this.wasmDecoder.isComplete()
  }

  /**
   * Get decode progress (0.0 to 1.0)
   */
  getProgress(): number {
    return this.wasmDecoder.getProgress()
  }

  /**
   * Get number of decoded blocks
   */
  getDecodedBlockCount(): number {
    return this.wasmDecoder.getDecodedBlockCount()
  }

  /**
   * Get number of received chunks
   */
  getReceivedChunkCount(): number {
    return this.wasmDecoder.getReceivedChunkCount()
  }

  /**
   * Get sorted list of decoded block indices
   */
  getDecodedBlockIndices(): number[] {
    const indices = this.wasmDecoder.getDecodedBlockIndices()
    return Array.from(indices) as number[]
  }

  /**
   * Get the decoded data (returns null if not complete)
   */
  getDecodedData(): Uint8Array | null {
    return this.wasmDecoder.getDecodedData() || null
  }

  /**
   * Get metadata
   */
  getMetadata(): FountainMetadata {
    return this.wasmDecoder.getMetadata() as FountainMetadata
  }
}
