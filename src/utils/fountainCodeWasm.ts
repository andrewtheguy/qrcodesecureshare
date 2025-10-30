import init, { WasmFountainEncoder, WasmFountainDecoder } from '../../rust/fountain-wasm/pkg/fountain_wasm'

// WASM initialization state
let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

/**
 * Ensures WASM module is initialized before use
 */
async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = init().then(() => {
      wasmInitialized = true
    })
  }

  await wasmInitPromise
}

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

  private constructor(
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
   * Create a new encoder (ensures WASM is initialized first)
   */
  static async create(
    data: Uint8Array,
    metadata: { name: string; type: string; timestamp?: number },
    options?: FountainEncoderOptions
  ): Promise<FountainWasmEncoder> {
    await ensureWasmInit()
    return new FountainWasmEncoder(data, metadata, options)
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

  private constructor(metadata: FountainMetadata, partBasedMode: boolean = false, partSize: number = 0) {
    this.wasmDecoder = new WasmFountainDecoder(
      metadata,
      partBasedMode ? true : undefined,
      partBasedMode && partSize > 0 ? partSize : undefined
    )
  }

  /**
   * Create a new decoder (ensures WASM is initialized first)
   */
  static async create(metadata: FountainMetadata, partBasedMode: boolean = false, partSize: number = 0): Promise<FountainWasmDecoder> {
    await ensureWasmInit()
    return new FountainWasmDecoder(metadata, partBasedMode, partSize)
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

  // Part-based mode methods

  /**
   * Check if the current part is complete
   */
  isCurrentPartComplete(): boolean {
    return this.wasmDecoder.isCurrentPartComplete()
  }

  /**
   * Get the current part data (returns null if not complete)
   */
  getCurrentPartData(): Uint8Array | null {
    return this.wasmDecoder.getCurrentPartData() || null
  }

  /**
   * Move to the next part
   * Returns true if moved, false if already at last part
   */
  moveToNextPart(): boolean {
    return this.wasmDecoder.moveToNextPart()
  }

  /**
   * Mark a part as completed
   */
  markPartCompleted(partIndex: number): void {
    this.wasmDecoder.markPartCompleted(partIndex)
  }

  /**
   * Get the number of decoded blocks in the current part
   */
  getCurrentPartDecodedBlockCount(): number {
    return this.wasmDecoder.getCurrentPartDecodedBlockCount()
  }

  /**
   * Get the total number of blocks in the current part
   */
  getCurrentPartTotalBlockCount(): number {
    return this.wasmDecoder.getCurrentPartTotalBlockCount()
  }

  /**
   * Get part info
   */
  getPartInfo(): { partBasedMode: boolean; currentPartIndex: number; totalParts: number; partSize: number } {
    const partInfo = this.wasmDecoder.getPartInfo()
    return partInfo as { partBasedMode: boolean; currentPartIndex: number; totalParts: number; partSize: number }
  }
}
