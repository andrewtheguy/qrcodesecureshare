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
 * All fields are required
 */
export interface FountainMetadata extends WasmFountainMetadata {
  type: string  // Alias for fileType for backward compatibility
  partBasedMode: boolean
  partSize: number
  checksum: string
  checksumAlg: string
}

/**
 * Part-based mode configuration (session-level settings)
 * Separate from encoding algorithm parameters
 */
export interface PartBasedModeConfig {
  enabled: boolean
  partSize: number
}

/**
 * Fountain encoder options (all fields required)
 * These are algorithm parameters, not session settings
 * Matches the Rust FountainEncoderOptions structure
 */
export interface FountainEncoderOptions {
  blockSize: number
  c: number
  delta: number
  maxDegree: number | null
  degree1Rate: number
  lowDegreeRate: number
  maxQRDataSize: number
  fixedOverhead: number
  partOverhead: number
}

/**
 * Default fountain encoder options
 * Single source of truth for default values
 */
export const DEFAULT_FOUNTAIN_ENCODER_OPTIONS: FountainEncoderOptions = {
  blockSize: 400,
  c: 0.2,
  delta: 0.01,
  maxDegree: null,
  degree1Rate: 0.08,
  lowDegreeRate: 0.18,
  maxQRDataSize: 1000,
  fixedOverhead: 10,
  partOverhead: 0,
}

/**
 * TypeScript wrapper for Rust WASM Fountain Encoder
 * Provides WASM initialization and a few convenience methods
 * Access underlying WASM encoder directly via the `wasm` property for all other methods
 */
export class FountainWasmEncoder {
  /**
   * Direct access to the underlying WASM encoder
   * Use this to call any WASM methods directly without delegation boilerplate
   */
  readonly wasm: WasmFountainEncoder

  private constructor(
    data: Uint8Array,
    metadata: { name: string; type: string; timestamp?: number },
    options: FountainEncoderOptions,
    partConfig: PartBasedModeConfig,
    seedOffset?: number
  ) {
    this.wasm = new WasmFountainEncoder(
      data,
      metadata.name,
      metadata.type,
      metadata.timestamp || Date.now(),
      options,
      partConfig.enabled,
      partConfig.partSize,
      seedOffset
    )
  }

  /**
   * Create a new encoder (ensures WASM is initialized first)
   *
   * @param data - Data to encode
   * @param metadata - File metadata
   * @param options - Encoding algorithm options (defaults to DEFAULT_FOUNTAIN_ENCODER_OPTIONS)
   * @param partConfig - Part-based mode configuration (defaults to disabled)
   * @param seedOffset - Optional seed offset for session-specific randomization
   */
  static async create(
    data: Uint8Array,
    metadata: { name: string; type: string; timestamp?: number },
    options: FountainEncoderOptions = DEFAULT_FOUNTAIN_ENCODER_OPTIONS,
    partConfig: PartBasedModeConfig = { enabled: false, partSize: 0 },
    seedOffset?: number
  ): Promise<FountainWasmEncoder> {
    await ensureWasmInit()
    return new FountainWasmEncoder(data, metadata, options, partConfig, seedOffset)
  }

  /**
   * Convenience method: Generate a single fountain chunk
   * Same as encoder.wasm.generateChunk()
   */
  generateChunk(): FountainChunk {
    return this.wasm.generateChunk() as FountainChunk
  }

  /**
   * Convenience method: Get metadata
   * Same as encoder.wasm.getMetadata()
   */
  getMetadata(): WasmFountainMetadata {
    return this.wasm.getMetadata() as WasmFountainMetadata
  }

  /**
   * Convenience method: Get part information
   * Same as encoder.wasm.getPartInfo()
   */
  getPartInfo(): {
    partBasedMode: boolean;
    currentPartIndex: number;
    totalParts: number;
    partSize: number;
    currentPartChecksum?: string;
    partChecksums?: string[];
  } {
    return this.wasm.getPartInfo() as {
      partBasedMode: boolean;
      currentPartIndex: number;
      totalParts: number;
      partSize: number;
      currentPartChecksum?: string;
      partChecksums?: string[];
    }
  }

  /**
   * Convenience method: Move to next part
   * Same as encoder.wasm.moveToNextPart()
   */
  moveToNextPart(): boolean {
    return this.wasm.moveToNextPart()
  }

  /**
   * Convenience method: Mark part as completed
   * Same as encoder.wasm.markPartCompleted()
   */
  markPartCompleted(partIndex: number): void {
    this.wasm.markPartCompleted(partIndex)
  }

  /**
   * Compute checksums for all parts asynchronously
   * Stores checksums in the encoder and returns them
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

    // Store checksums in the WASM encoder
    this.wasm.setPartChecksums(checksums)

    return checksums
  }
}

/**
 * TypeScript wrapper for Rust WASM Fountain Decoder
 * Provides WASM initialization and convenience methods
 * Access underlying WASM decoder directly via the `wasm` property for all other methods
 */
export class FountainWasmDecoder {
  /**
   * Direct access to the underlying WASM decoder
   * Use this to call any WASM methods directly without delegation boilerplate
   */
  readonly wasm: WasmFountainDecoder

  private constructor(metadata: WasmFountainMetadata, partBasedMode: boolean = false, partSize: number = 0) {
    this.wasm = new WasmFountainDecoder(
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
   * Convenience method: Add a chunk and attempt to decode
   * Same as decoder.wasm.addChunk(chunk)
   */
  addChunk(chunk: FountainChunk): boolean {
    return this.wasm.addChunk(chunk)
  }

  /**
   * Convenience method: Check if decoding is complete
   * Same as decoder.wasm.isComplete()
   */
  isComplete(): boolean {
    return this.wasm.isComplete()
  }

  /**
   * Convenience method: Get overall decode progress (0.0 to 1.0)
   * Same as decoder.wasm.getProgress()
   */
  getProgress(): number {
    return this.wasm.getProgress()
  }

  /**
   * Convenience method: Get the decoded data
   * Same as decoder.wasm.getDecodedData()
   */
  getDecodedData(): Uint8Array | null {
    return this.wasm.getDecodedData() || null
  }

  /**
   * Convenience method: Get metadata
   * Same as decoder.wasm.getMetadata()
   */
  getMetadata(): WasmFountainMetadata {
    return this.wasm.getMetadata() as WasmFountainMetadata
  }

  /**
   * Convenience method: Get part info
   * Same as decoder.wasm.getPartInfo()
   */
  getPartInfo(): {
    partBasedMode: boolean;
    currentPartIndex: number;
    totalParts: number;
    partSize: number;
    currentPartChecksum?: string;
    partChecksums?: string[];
  } {
    const partInfo = this.wasm.getPartInfo()
    return partInfo as {
      partBasedMode: boolean;
      currentPartIndex: number;
      totalParts: number;
      partSize: number;
      currentPartChecksum?: string;
      partChecksums?: string[];
    }
  }

  /**
   * Convenience method: Get number of decoded blocks
   * Same as decoder.wasm.getDecodedBlockCount()
   */
  getDecodedBlockCount(): number {
    return this.wasm.getDecodedBlockCount()
  }

  /**
   * Convenience method: Get decoded block indices
   * Same as decoder.wasm.getDecodedBlockIndices()
   */
  getDecodedBlockIndices(): number[] {
    const indices = this.wasm.getDecodedBlockIndices()
    return Array.from(indices) as number[]
  }

  /**
   * Convenience method: Check if current part is complete
   * Same as decoder.wasm.isCurrentPartComplete()
   */
  isCurrentPartComplete(): boolean {
    return this.wasm.isCurrentPartComplete()
  }

  /**
   * Convenience method: Get current part data
   * Same as decoder.wasm.getCurrentPartData()
   */
  getCurrentPartData(): Uint8Array | null {
    return this.wasm.getCurrentPartData() || null
  }

  /**
   * Convenience method: Mark part as completed
   * Same as decoder.wasm.markPartCompleted()
   */
  markPartCompleted(partIndex: number): void {
    this.wasm.markPartCompleted(partIndex)
  }

  /**
   * Convenience method: Get current part decoded block count
   * Same as decoder.wasm.getCurrentPartDecodedBlockCount()
   */
  getCurrentPartDecodedBlockCount(): number {
    return this.wasm.getCurrentPartDecodedBlockCount()
  }

  /**
   * Convenience method: Get current part total block count
   * Same as decoder.wasm.getCurrentPartTotalBlockCount()
   */
  getCurrentPartTotalBlockCount(): number {
    return this.wasm.getCurrentPartTotalBlockCount()
  }

  /**
   * Convenience method: Move to next part
   * Same as decoder.wasm.moveToNextPart()
   */
  moveToNextPart(): boolean {
    return this.wasm.moveToNextPart()
  }
}

// Re-export with simplified names for backward compatibility with fountainCodeHybrid
export { FountainWasmEncoder as FountainEncoder, FountainWasmDecoder as FountainDecoder }
