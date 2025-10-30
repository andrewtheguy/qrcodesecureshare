import init, { WasmFountainEncoder, WasmFountainDecoder } from '../../rust/fountain-wasm/pkg/fountain_wasm'

// WASM initialization state
let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

/**
 * Ensures WASM module is initialized before use
 * Includes bounded retry (2 attempts) with short delay
 * @throws Error with code 'WASM_INIT_FAILED' if initialization fails
 */
async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const MAX_RETRIES = 2
      const RETRY_DELAY_MS = 100

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await init()
          wasmInitialized = true
          return
        } catch (err) {
          console.error(`[WASM Init] Attempt ${attempt}/${MAX_RETRIES} failed:`, err)

          if (attempt === MAX_RETRIES) {
            // Final attempt failed - throw specific error
            const error = new Error(
              `WASM_INIT_FAILED: Failed to initialize WASM module after ${MAX_RETRIES} attempts. ` +
              `The WASM bundle may not be loaded. Please refresh the page and try again. ` +
              `Original error: ${err instanceof Error ? err.message : String(err)}`
            )
            throw error
          }

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
        }
      }
    })()
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

/**
 * WASM-bound metadata type
 * This matches the exact structure expected by Rust WASM code
 * Note: fileType (not type), no checksum fields
 */
export interface WasmFountainMetadata {
  name: string
  size: number
  fileType: string
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
}

/**
 * Extended metadata type for application use
 * Includes all fields from WasmFountainMetadata plus additional app-level fields
 */
export interface FountainMetadata extends WasmFountainMetadata {
  type?: string  // Alias for fileType for backward compatibility
  partBasedMode?: boolean
  partSize?: number
  checksum?: string
  checksumAlg?: string
}

export interface FountainEncoderOptions {
  blockSize?: number
  c?: number
  delta?: number
  seedOffset?: number
  fixedOverhead?: number
  partOverhead?: number
  maxDegree?: number
  degree1Rate?: number
  lowDegreeRate?: number
  maxQRDataSize?: number
  partBasedMode?: boolean
  partSize?: number
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
      options?.delta,
      options?.seedOffset,
      options?.fixedOverhead,
      options?.partOverhead,
      options?.maxDegree,
      options?.degree1Rate,
      options?.lowDegreeRate,
      options?.maxQRDataSize,
      options?.partBasedMode,
      options?.partSize
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
  getMetadata(): WasmFountainMetadata {
    return this.wasmEncoder.getMetadata() as WasmFountainMetadata
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

  // ========================================
  // Targeted Mode Methods
  // ========================================

  /**
   * Set which blocks the receiver has already decoded
   * This enables targeted encoding that focuses on missing blocks
   */
  setReceivedBlocks(blockIndices: number[]): void {
    this.wasmEncoder.setReceivedBlocks(new Uint32Array(blockIndices))
  }

  /**
   * Set which blocks the receiver still needs (missing blocks)
   * This enables targeted encoding that focuses on missing blocks
   */
  setMissingBlocks(missingIndices: number[]): void {
    this.wasmEncoder.setMissingBlocks(new Uint32Array(missingIndices))
  }

  // ========================================
  // Part-Based Mode Methods
  // ========================================

  /**
   * Get part information
   */
  getPartInfo(): {
    partBasedMode: boolean;
    currentPartIndex: number;
    totalParts: number;
    partSize: number;
    currentPartChecksum?: string;
    partChecksums?: string[];
  } {
    return this.wasmEncoder.getPartInfo() as {
      partBasedMode: boolean;
      currentPartIndex: number;
      totalParts: number;
      partSize: number;
      currentPartChecksum?: string;
      partChecksums?: string[];
    }
  }

  /**
   * Move to the next part
   * Returns true if moved, false if already at last part
   */
  moveToNextPart(): boolean {
    return this.wasmEncoder.moveToNextPart()
  }

  /**
   * Mark a part as completed
   */
  markPartCompleted(partIndex: number): void {
    this.wasmEncoder.markPartCompleted(partIndex)
  }

  /**
   * Get contiguous blocks data
   */
  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    return this.wasmEncoder.getContiguousBlocksData(startIdx, endIdx) || null
  }

  /**
   * Compute checksums for all parts asynchronously
   * Returns array of CRC32 checksums (one per part)
   */
  async computePartChecksums(originalData: Uint8Array): Promise<string[]> {
    const { crc32 } = await import('../wasm/fountain_wasm')
    const { partBasedMode, totalParts, partSize } = this.getPartInfo()

    if (!partBasedMode || totalParts === 0) {
      return []
    }

    const checksums: string[] = []
    for (let i = 0; i < totalParts; i++) {
      const partStartByte = i * partSize
      const partEndByte = Math.min((i + 1) * partSize, originalData.length)
      const partData = originalData.slice(partStartByte, partEndByte)
      checksums.push(crc32(partData))
    }

    return checksums
  }
}

/**
 * TypeScript wrapper for Rust WASM Fountain Decoder
 */
export class FountainWasmDecoder {
  private wasmDecoder: WasmFountainDecoder

  private constructor(metadata: WasmFountainMetadata, partBasedMode: boolean = false, partSize: number = 0) {
    this.wasmDecoder = new WasmFountainDecoder(
      metadata,
      partBasedMode ? true : undefined,
      partBasedMode && partSize > 0 ? partSize : undefined
    )
  }

  /**
   * Create a new decoder (ensures WASM is initialized first)
   */
  static async create(metadata: WasmFountainMetadata, partBasedMode: boolean = false, partSize: number = 0): Promise<FountainWasmDecoder> {
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
   * Get overall decode progress (0.0 to 1.0)
   * Returns the fraction of total blocks decoded across the entire file.
   * In part-based mode, this represents overall file progress, not current part progress.
   * Use getCurrentPartDecodedBlockCount() / getCurrentPartTotalBlockCount() for part-specific progress.
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
  getMetadata(): WasmFountainMetadata {
    return this.wasmDecoder.getMetadata() as WasmFountainMetadata
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
  getPartInfo(): {
    partBasedMode: boolean;
    currentPartIndex: number;
    totalParts: number;
    partSize: number;
    currentPartChecksum?: string;
    partChecksums?: string[];
  } {
    const partInfo = this.wasmDecoder.getPartInfo()
    return partInfo as {
      partBasedMode: boolean;
      currentPartIndex: number;
      totalParts: number;
      partSize: number;
      currentPartChecksum?: string;
      partChecksums?: string[];
    }
  }
}

// Re-export with simplified names for backward compatibility with fountainCodeHybrid
export { FountainWasmEncoder as FountainEncoder, FountainWasmDecoder as FountainDecoder }
