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
 *  - Belief propagation decoding - handled by WASM decoder (except part-based mode)
 *  - For part-based mode, JavaScript decoder is still used (WASM doesn't support it yet)
 */

// XOR two Uint8Arrays (used by decoder in part-based mode)
function xorArrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(Math.max(a.length, b.length))
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i]
  }
  for (let i = 0; i < b.length; i++) {
    result[i] ^= b[i]
  }
  return result
}

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
  private decodedBlocks: Map<number, Uint8Array> = new Map()
  private receivedChunks: FountainChunk[] = []
  private isDecoded: boolean = false

  // Part-based transfer fields
  private partBasedMode: boolean = false
  private partSize: number = 0
  private totalParts: number = 0
  private currentPartIndex: number = 0
  private completedParts: Set<number> = new Set()
  private storedPartData: Map<number, Uint8Array> = new Map() // Store reconstructed part data

  constructor(metadata: FountainMetadata, partBasedMode: boolean = false, partSize: number = 0) {
    // Validate part-based mode parameters
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

  // Add a received chunk and try to decode
  addChunk(chunk: FountainChunk): boolean {
    if (this.isDecoded) return true

    this.receivedChunks.push(chunk)
    return this.attemptDecode()
  }

  private attemptDecode(): boolean {
    // Keep original chunks and track which indices are still active
    interface WorkingChunk {
      data: Uint8Array
      activeIndices: Set<number>
    }

    const workingChunks: WorkingChunk[] = this.receivedChunks.map(chunk => ({
      data: new Uint8Array(chunk.data),
      activeIndices: new Set(chunk.indices)
    }))

    const decoded = new Map<number, Uint8Array>()

    // Iteratively decode using belief propagation (peeling decoder)
    let madeProgress = true
    while (madeProgress) {
      madeProgress = false

      for (let i = 0; i < workingChunks.length; i++) {
        const chunk = workingChunks[i]

        // If this chunk has exactly one active (undecoded) index, we can decode it
        if (chunk.activeIndices.size === 1) {
          const blockIdx = Array.from(chunk.activeIndices)[0]

          if (!decoded.has(blockIdx)) {
            // The chunk data now equals the undecoded block (after all previous XORs)
            decoded.set(blockIdx, new Uint8Array(chunk.data))
            madeProgress = true

            // XOR this newly decoded block out of all other chunks
            for (let j = 0; j < workingChunks.length; j++) {
              if (j !== i && workingChunks[j].activeIndices.has(blockIdx)) {
                // XOR the decoded block out of this chunk
                workingChunks[j].data = xorArrays(workingChunks[j].data, chunk.data)
                // Remove this block from active indices
                workingChunks[j].activeIndices.delete(blockIdx)
              }
            }

            // Mark this block as inactive in the current chunk
            chunk.activeIndices.delete(blockIdx)
          }
        }
      }
    }

    this.decodedBlocks = decoded
    this.isDecoded = decoded.size === this.metadata.totalSourceBlocks

    return this.isDecoded
  }

  getProgress(): number {
    return this.decodedBlocks.size / this.metadata.totalSourceBlocks
  }

  isComplete(): boolean {
    if (this.partBasedMode) {
      // In part-based mode, complete when all parts are stored
      return this.storedPartData.size === this.totalParts
    }
    return this.isDecoded
  }

  getMetadata(): FountainMetadata {
    return this.metadata
  }

  // Reconstruct the original data
  getDecodedData(): Uint8Array | null {
    // In part-based mode, check if all parts are completed
    if (this.partBasedMode) {
      return this.getDecodedDataFromParts()
    }

    if (!this.isDecoded) return null

    // Reassemble blocks in order
    const result = new Uint8Array(this.metadata.size)
    let offset = 0

    for (let i = 0; i < this.metadata.totalSourceBlocks; i++) {
      const block = this.decodedBlocks.get(i)
      if (!block) return null

      const bytesToCopy = Math.min(this.metadata.blockSize, this.metadata.size - offset)
      result.set(block.slice(0, bytesToCopy), offset)
      offset += bytesToCopy
    }

    return result
  }

  /**
   * Reconstruct the final file from stored part data
   */
  private getDecodedDataFromParts(): Uint8Array | null {
    if (!this.partBasedMode) return null
    if (this.storedPartData.size !== this.totalParts) return null

    // Check that all parts are present
    for (let i = 0; i < this.totalParts; i++) {
      if (!this.storedPartData.has(i)) return null
    }

    // Concatenate all parts in order
    const result = new Uint8Array(this.metadata.size)
    let offset = 0

    for (let i = 0; i < this.totalParts; i++) {
      const partData = this.storedPartData.get(i)
      if (!partData) return null

      result.set(partData, offset)
      offset += partData.length
    }

    console.log(`Final file reconstructed from ${this.totalParts} parts (${result.length} bytes)`)
    return result
  }

  getReceivedChunkCount(): number {
    return this.receivedChunks.length
  }

  getDecodedBlockCount(): number {
    return this.decodedBlocks.size
  }

  getDecodedBlockIndices(): number[] {
    return Array.from(this.decodedBlocks.keys()).sort((a, b) => a - b)
  }

  /**
   * Get contiguous blocks data for checksum computation
   */
  getContiguousBlocksData(startIdx: number, endIdx: number): Uint8Array | null {
    if (startIdx < 0 || endIdx > this.metadata.totalSourceBlocks || startIdx >= endIdx) {
      return null
    }

    // Check that all blocks in range are decoded
    for (let i = startIdx; i < endIdx; i++) {
      if (!this.decodedBlocks.has(i)) {
        return null
      }
    }

    const totalSize = (endIdx - startIdx) * this.metadata.blockSize
    const result = new Uint8Array(totalSize)
    let offset = 0

    for (let i = startIdx; i < endIdx; i++) {
      const block = this.decodedBlocks.get(i)!
      result.set(block, offset)
      offset += this.metadata.blockSize
    }

    return result
  }

  /**
   * Check if the current part is complete (all blocks in part decoded)
   */
  isCurrentPartComplete(): boolean {
    if (!this.partBasedMode) return this.isDecoded

    const partStartByte = this.currentPartIndex * this.partSize
    const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.metadata.size)

    const startBlockIndex = Math.floor(partStartByte / this.metadata.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.metadata.blockSize)

    for (let i = startBlockIndex; i < endBlockIndex && i < this.metadata.totalSourceBlocks; i++) {
      if (!this.decodedBlocks.has(i)) {
        return false
      }
    }

    return true
  }

  /**
   * Get the data for the current part (for checksum validation)
   * Returns null if part is not complete
   */
  getCurrentPartData(): Uint8Array | null {
    if (!this.partBasedMode || !this.isCurrentPartComplete()) return null

    const partStartByte = this.currentPartIndex * this.partSize
    const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.metadata.size)
    const partDataSize = partEndByte - partStartByte

    const result = new Uint8Array(partDataSize)
    let resultOffset = 0

    const startBlockIndex = Math.floor(partStartByte / this.metadata.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.metadata.blockSize)

    for (let i = startBlockIndex; i < endBlockIndex && i < this.metadata.totalSourceBlocks; i++) {
      const block = this.decodedBlocks.get(i)
      if (!block) return null

      const blockStartInPart = Math.max(0, partStartByte - i * this.metadata.blockSize)
      const blockEndInPart = Math.min(this.metadata.blockSize, partEndByte - i * this.metadata.blockSize)
      const bytesToCopy = blockEndInPart - blockStartInPart

      result.set(block.slice(blockStartInPart, blockEndInPart), resultOffset)
      resultOffset += bytesToCopy
    }

    return result
  }

  /**
   * Get part information
   */
  getPartInfo(): {
    partBasedMode: boolean
    currentPartIndex: number
    totalParts: number
    partSize: number
    completedParts: number[]
  } {
    return {
      partBasedMode: this.partBasedMode,
      currentPartIndex: this.currentPartIndex,
      totalParts: this.totalParts,
      partSize: this.partSize,
      completedParts: Array.from(this.completedParts).sort((a, b) => a - b)
    }
  }

  /**
   * Mark a part as completed and clean up its decoded blocks to save memory
   */
  markPartCompleted(partIndex: number): void {
    if (!this.partBasedMode) return
    if (partIndex < 0 || partIndex >= this.totalParts) return

    // First, reconstruct and store the part data before cleanup
    const partData = this.getCurrentPartData()
    if (partData) {
      this.storedPartData.set(partIndex, partData)
      console.log(`Part ${partIndex + 1}/${this.totalParts} reconstructed and stored (${partData.length} bytes)`)
    }

    this.completedParts.add(partIndex)

    const partStartByte = partIndex * this.partSize
    const partEndByte = Math.min((partIndex + 1) * this.partSize, this.metadata.size)

    const startBlockIndex = Math.floor(partStartByte / this.metadata.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.metadata.blockSize)

    // Clear decoded blocks for this part to save memory
    for (let i = startBlockIndex; i < endBlockIndex && i < this.metadata.totalSourceBlocks; i++) {
      this.decodedBlocks.delete(i)
    }

    // Clear received chunks that only contain blocks from completed parts
    this.receivedChunks = this.receivedChunks.filter(chunk => {
      return chunk.indices.some(idx => {
        const blockPartIndex = Math.floor((idx * this.metadata.blockSize) / this.partSize)
        return !this.completedParts.has(blockPartIndex)
      })
    })

    console.log(`Part ${partIndex + 1} memory cleaned up. Active blocks: ${this.decodedBlocks.size}, Active chunks: ${this.receivedChunks.length}`)
  }

  /**
   * Move to the next part
   * Returns true if moved to next part, false if already at last part
   */
  moveToNextPart(): boolean {
    if (!this.partBasedMode) return false
    if (this.currentPartIndex >= this.totalParts - 1) return false

    // Mark current part as completed before moving
    if (this.isCurrentPartComplete()) {
      this.markPartCompleted(this.currentPartIndex)
    }

    this.currentPartIndex++
    return true
  }

  /**
   * Get the number of decoded blocks in the current part
   */
  getCurrentPartDecodedBlockCount(): number {
    if (!this.partBasedMode) return this.decodedBlocks.size

    const partStartByte = this.currentPartIndex * this.partSize
    const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.metadata.size)

    const startBlockIndex = Math.floor(partStartByte / this.metadata.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.metadata.blockSize)

    let count = 0
    for (let i = startBlockIndex; i < endBlockIndex && i < this.metadata.totalSourceBlocks; i++) {
      if (this.decodedBlocks.has(i)) {
        count++
      }
    }

    return count
  }

  /**
   * Get the total number of blocks in the current part
   */
  getCurrentPartTotalBlockCount(): number {
    if (!this.partBasedMode) return this.metadata.totalSourceBlocks

    const partStartByte = this.currentPartIndex * this.partSize
    const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.metadata.size)

    const startBlockIndex = Math.floor(partStartByte / this.metadata.blockSize)
    const endBlockIndex = Math.ceil(partEndByte / this.metadata.blockSize)

    return Math.min(endBlockIndex - startBlockIndex, this.metadata.totalSourceBlocks - startBlockIndex)
  }

}
