/**
 * Fountain (LT) Code Implementation – Coordination Layer
 *
 * This file provides coordination logic for fountain encoding/decoding:
 *  - Part-based transfer for large files: splits files into fixed-size parts (256KB/512KB/1024KB)
 *    with independent checksum validation and memory cleanup
 *  - State management for encoder/decoder
 *  - Metadata handling
 *
 * COMPUTATION LOGIC HAS BEEN MOVED TO RUST WASM:
 *  - Chunk generation (XOR operations, degree sampling) - handled by WASM encoder
 *  - Belief propagation decoding - handled by WASM decoder (including part-based mode)
 *  - Part-based mode - fully supported in WASM for better performance
 */

export interface FountainChunk {
  seed: number           // Seed for this chunk's random generation
  degree: number         // Number of source blocks combined
  indices: number[]      // Which source blocks are XORed together
  data: Uint8Array       // The encoded data
}

export interface FountainMetadata {
  name: string
  size: number
  type: string
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
  checksum: string
  checksumAlg: string
  partBasedMode?: boolean
  partSize?: number
}

export interface FountainEncoderOptions {
  blockSize?: number
  c?: number          // robust soliton parameter (passed to WASM)
  delta?: number      // failure probability target (passed to WASM)
  maxDegree?: number  // hard ceiling (passed to WASM)
  degree1Rate?: number  // (passed to WASM)
  lowDegreeRate?: number  // (passed to WASM)
  maxQRDataSize?: number  // maximum QR data size in bytes (passed to WASM)
  // Part-based transfer options
  partBasedMode?: boolean  // enable part-based transfer (feedback mode only)
  partSize?: number  // size of each part in bytes (256KB, 512KB, or 1024KB)
}

export class FountainEncoder {
  private sourceBlocks: Uint8Array[] = []
  private blockSize: number
  private metadata: FountainMetadata
  private receivedBlocks: Set<number> = new Set()
  private targetedMode: boolean = false

  // Part-based transfer fields
  private partBasedMode: boolean = false
  private partSize: number = 0
  private totalParts: number = 0
  private currentPartIndex: number = 0
  private partChecksums: string[] = []
  private originalData: Uint8Array

  constructor(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ) {
    // Validate part-based mode parameters
    if (opts.partBasedMode && (!opts.partSize || opts.partSize <= 0)) {
      throw new Error('partSize must be > 0 when partBasedMode is enabled')
    }

    this.originalData = data
    this.blockSize = opts.blockSize ?? 400

    // Initialize part-based mode if enabled
    if (opts.partBasedMode && opts.partSize) {
      this.partBasedMode = true
      this.partSize = opts.partSize
      this.totalParts = Math.ceil(data.length / this.partSize)
      this.currentPartIndex = 0
      // Initialize with empty checksums array - will be computed asynchronously
      this.partChecksums = new Array(this.totalParts).fill('')
    }

    const numBlocks = Math.ceil(data.length / this.blockSize)

    for (let i = 0; i < numBlocks; i++) {
      const start = i * this.blockSize
      const end = Math.min(start + this.blockSize, data.length)
      const block = new Uint8Array(this.blockSize)
      block.set(data.slice(start, end))
      this.sourceBlocks.push(block)
    }

    this.metadata = { ...metadata, totalSourceBlocks: numBlocks, blockSize: this.blockSize }
  }

  /**
   * Compute checksums for all parts asynchronously
   * Should be called after encoder initialization
   */
  async computePartChecksums(): Promise<void> {
    if (!this.partBasedMode) return

    const { computeChecksum } = await import('./checksum')

    for (let i = 0; i < this.totalParts; i++) {
      const partStartByte = i * this.partSize
      const partEndByte = Math.min((i + 1) * this.partSize, this.originalData.length)
      const partData = this.originalData.slice(partStartByte, partEndByte)
      this.partChecksums[i] = await computeChecksum(partData, 'crc32')
    }
  }

  /**
   * Get part information
   */
  getPartInfo(): {
    partBasedMode: boolean
    currentPartIndex: number
    totalParts: number
    partSize: number
    currentPartChecksum: string
    partChecksums: string[]
  } {
    return {
      partBasedMode: this.partBasedMode,
      currentPartIndex: this.currentPartIndex,
      totalParts: this.totalParts,
      partSize: this.partSize,
      currentPartChecksum: this.partChecksums[this.currentPartIndex] || '',
      partChecksums: [...this.partChecksums]
    }
  }

  /**
   * Move to the next part
   * Returns true if moved to next part, false if already at last part
   */
  moveToNextPart(): boolean {
    if (!this.partBasedMode) return false
    if (this.currentPartIndex >= this.totalParts - 1) return false

    this.currentPartIndex++

    // Reset targeted mode for new part
    this.targetedMode = false
    this.receivedBlocks.clear()

    return true
  }

  /**
   * Mark a part as completed and clean up its source blocks to save memory
   * This is called by the sender when receiver confirms part completion
   */
  markPartCompleted(partIndex: number): void {
    if (!this.partBasedMode) return
    if (partIndex < 0 || partIndex >= this.totalParts) return

    const partStartByte = partIndex * this.partSize
    const partEndByte = Math.min((partIndex + 1) * this.partSize, this.originalData.length)

    const startBlockIndex = Math.floor(partStartByte / this.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.blockSize)

    // Clear source blocks for this part to save memory
    for (let i = startBlockIndex; i < endBlockIndex && i < this.sourceBlocks.length; i++) {
      // Replace with empty array to free memory
      this.sourceBlocks[i] = new Uint8Array(0)
    }
  }

  getMetadata(): FountainMetadata { return this.metadata }

  /**
   * Set which blocks the receiver has already decoded
   * This enables targeted encoding that focuses on missing blocks
   */
  setReceivedBlocks(blockIndices: number[]): void {
    this.receivedBlocks = new Set(blockIndices)
    this.targetedMode = this.receivedBlocks.size > 0
  }

  /**
   * Set which blocks the receiver still needs (missing blocks)
   * This enables targeted encoding that focuses on missing blocks
   */
  setMissingBlocks(blockIndices: number[]): void {
    const totalBlocks = this.sourceBlocks.length
    this.receivedBlocks = new Set()
    for (let i = 0; i < totalBlocks; i++) {
      if (!blockIndices.includes(i)) {
        this.receivedBlocks.add(i)
      }
    }
    this.targetedMode = this.receivedBlocks.size > 0
  }

  /**
   * Get available blocks for chunk generation
   * In part-based mode, returns blocks in current part
   * Otherwise, returns all blocks
   */
  private getAvailableBlocks(): number[] {
    if (this.partBasedMode) {
      // Calculate blocks for current part
      const partStartByte = this.currentPartIndex * this.partSize
      const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.originalData.length)
      const startBlockIndex = Math.floor(partStartByte / this.blockSize)
      const endBlockIndex = Math.ceil(partEndByte / this.blockSize)

      return Array.from(
        { length: endBlockIndex - startBlockIndex },
        (_, i) => i + startBlockIndex
      )
    } else {
      // Return all blocks
      return Array.from({ length: this.sourceBlocks.length }, (_, i) => i)
    }
  }

  /**
   * Get contiguous blocks data for checksum validation
   */
  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    if (startIdx < 0 || endIdx > this.sourceBlocks.length || startIdx >= endIdx) {
      return null
    }

    const totalSize = (endIdx - startIdx) * this.blockSize
    const result = new Uint8Array(totalSize)
    let offset = 0

    for (let i = startIdx; i < endIdx; i++) {
      result.set(this.sourceBlocks[i], offset)
      offset += this.blockSize
    }

    return result
  }
}

export class FountainDecoder {
  private metadata: FountainMetadata
  private partBasedMode: boolean = false
  private partSize: number = 0
  private totalParts: number = 0
  private currentPartIndex: number = 0

  constructor(metadata: FountainMetadata, partBasedMode: boolean = false, partSize: number = 0) {
    if (partBasedMode && partSize <= 0) {
      throw new Error('partSize must be > 0 when partBasedMode is enabled')
    }

    this.metadata = metadata
    this.partBasedMode = partBasedMode
    this.partSize = partSize

    if (this.partBasedMode) {
      this.totalParts = Math.ceil(metadata.size / partSize)
      this.currentPartIndex = 0
    }
  }

  /**
   * Add chunk (stub - actual decoding in WASM)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addChunk(_chunk: FountainChunk): boolean {
    return false
  }

  getMetadata(): FountainMetadata {
    return this.metadata
  }

  /**
   * Get contiguous blocks data (stub - not used)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getContiguousBlocksData(_startIdx: number, _endIdx: number): Uint8Array | null {
    return null
  }

  /**
   * Move to next part
   */
  moveToNextPart(): boolean {
    if (!this.partBasedMode || this.currentPartIndex >= this.totalParts - 1) {
      return false
    }
    this.currentPartIndex++
    return true
  }

  /**
   * Mark part completed (stub - actual state in WASM)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  markPartCompleted(_partIndex: number): void {
    // Stub - actual state managed in WASM
  }
}
