import { WINDOW_ENABLE_THRESHOLD, getSegmentSizeBlocks, getBaselineWindowExpansionBlocks } from './fountainConfig'

/**
 * Fountain (LT) Code Implementation – Tuned Version (NOT backward compatible)
 *
 * Key changes vs previous version:
 *  - Uses configurable robust soliton with tighter failure probability (delta=0.01)
 *  - Adds degree "doping" (forced low-degree symbols) to maintain healthy ripple
 *  - Adaptive max degree: min(40, max(8, round(2.5 * sqrt(k))))
 *  - Renormalizes distribution when truncated by max degree
 *  - Exposes tuning + runtime stats (avg degree, produced chunks, unique indices coverage)
 *  - Simplified generateChunk(): no parameter – encoder owns all tuning
 *  - Segment-based windowing for files > 200KB: treats large files as multiple small file segments.
 *    Window expansion is derived from the segment size and adaptive threshold rather than a fixed byte cap,
 *    allowing larger jumps when the receiver has already decoded substantial portions of the window.
 *
 * Recommended single-session max file size with default blockSize=400 bytes:
 *   Green zone: ≤ ~200 KB (k ≲ 500)
 *   Yellow zone: 200–250 KB (k 500–625) – still fine
 *   Red (split recommended): > 250 KB
 * Time estimate (default fps=2, overhead≈1.08): T ≈ 0.0009 * fileBytes seconds
 */

// Pseudo-random number generator with seed (for reproducibility)
class SeededRandom {
  private seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280
    return this.seed / 233280
  }
}

// Core Robust Soliton distribution (before truncation or doping)
function robustSolitonDistribution(k: number, c: number, delta: number): number[] {
  const R = c * Math.log(k / delta) * Math.sqrt(k)
  const probs: number[] = new Array(k).fill(0)

  // Ideal Soliton
  probs[0] = 1 / k
  for (let i = 2; i <= k; i++) probs[i - 1] = 1 / (i * (i - 1))

  // Tau (robust component)
  const tau: number[] = new Array(k).fill(0)
  const threshold = Math.floor(k / R)
  for (let i = 1; i < threshold; i++) tau[i - 1] = R / (i * k)
  if (threshold - 1 >= 0 && threshold - 1 < k) {
    tau[threshold - 1] = R * Math.log(R / delta) / k
  }

  const sumBase = probs.reduce((s, v) => s + v, 0)
  const sumTau = tau.reduce((s, v) => s + v, 0)
  const beta = sumBase + sumTau
  for (let i = 0; i < k; i++) probs[i] = (probs[i] + tau[i]) / beta
  return probs
}

// Build truncated + renormalized distribution subject to maxDegree
function buildDegreeDistribution(k: number, c: number, delta: number, maxDegree: number): number[] {
  const base = robustSolitonDistribution(k, c, delta)
  const limit = Math.min(maxDegree, k)
  const truncated = base.slice(0, limit)
  const sum = truncated.reduce((s, v) => s + v, 0)
  for (let i = 0; i < truncated.length; i++) truncated[i] /= sum
  return truncated
}

interface DegreeSamplerOptions {
  degree1Rate: number      // forced degree=1 probability
  lowDegreeRate: number    // additional probability region for degree 2-3
}

function sampleDegree(rng: SeededRandom, dist: number[], opts: DegreeSamplerOptions): number {
  const r = rng.next()
  if (r < opts.degree1Rate) return 1
  if (r < opts.degree1Rate + opts.lowDegreeRate) {
    // degree 2 or 3 (favor 2 slightly)
    return rng.next() < 0.6 ? 2 : 3
  }
  // sample from truncated robust soliton distribution
  const r2 = rng.next()
  let cumulative = 0
  for (let i = 0; i < dist.length; i++) {
    cumulative += dist[i]
    if (r2 <= cumulative) return i + 1
  }
  return dist.length
}

// XOR two Uint8Arrays
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
  c?: number          // robust soliton parameter
  delta?: number      // failure probability target
  maxDegree?: number  // hard ceiling (auto chosen if omitted)
  degree1Rate?: number
  lowDegreeRate?: number
  windowEnabled?: boolean  // force disable windowing (default: auto based on file size)
  maxQRDataSize?: number  // maximum QR data size in bytes (for degree tuning)
  // Part-based transfer options
  partBasedMode?: boolean  // enable part-based transfer (feedback mode only)
  partSize?: number  // size of each part in bytes (256KB, 512KB, or 1024KB)
}

export interface FountainEncoderStats {
  producedChunks: number
  avgDegree: number
  uniqueBlockCoverage: number  // fraction of source blocks appearing in at least one emitted chunk
  windowCoverage: number
}

export class FountainEncoder {
  private sourceBlocks: Uint8Array[] = []
  private blockSize: number
  private degreeDist: number[]
  private metadata: FountainMetadata
  private chunkCounter = 0
  private sumDegrees = 0
  private seenBlocks: Set<number> = new Set()
  private samplerOpts: DegreeSamplerOptions
  private receivedBlocks: Set<number> = new Set()
  private targetedMode: boolean = false
  private windowStart: number = 0
  private windowEnd: number = 0
  private windowEnabled: boolean = false
  private skipBlocksBelow: number = 0

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

    // Calculate max degree based on QR capacity constraints
    // QR chunk size = 2 (magic) + 2 (seed) + 1 (degree) + 1 (numIndices) + (degree * 2) + blockSize + 4 (checksum)
    // Rearrange: degree * 2 <= maxQRDataSize - 2 - 2 - 1 - 1 - blockSize - 4
    // degree <= (maxQRDataSize - blockSize - 10) / 2
    const maxQRDataSize = opts.maxQRDataSize ?? 1000 // Conservative default
    const maxDegreeFromQRCapacity = Math.floor((maxQRDataSize - this.blockSize - 10) / 2)
    
    // Validate and clamp maxDegreeFromQRCapacity to prevent zero or negative values
    if (maxDegreeFromQRCapacity < 1) {
      throw new Error(`maxQRDataSize (${maxQRDataSize}) is too small for blockSize (${this.blockSize}). Minimum required: ${this.blockSize + 10 + 2}`)
    }
    
    // Validate opts.maxDegree if provided
    if (opts.maxDegree !== undefined && opts.maxDegree <= 0) {
      throw new Error(`opts.maxDegree must be > 0, got: ${opts.maxDegree}`)
    }
    
    // Use formula-based adaptive degree with QR capacity constraint
    const formulaMaxDegree = Math.min(40, Math.max(8, Math.round(2.5 * Math.sqrt(numBlocks))))
    const adaptiveMaxDegree = opts.maxDegree !== undefined 
      ? Math.min(opts.maxDegree, maxDegreeFromQRCapacity, formulaMaxDegree)
      : Math.min(formulaMaxDegree, maxDegreeFromQRCapacity)
    
    const c = opts.c ?? 0.2
    const delta = opts.delta ?? 0.01
    this.degreeDist = buildDegreeDistribution(numBlocks, c, delta, adaptiveMaxDegree)
    this.samplerOpts = {
      degree1Rate: opts.degree1Rate ?? 0.08,
      lowDegreeRate: opts.lowDegreeRate ?? 0.18
    }

    this.metadata = { ...metadata, totalSourceBlocks: numBlocks, blockSize: this.blockSize }

    // Initialize window state
    // SENDER IS THE SINGLE SOURCE OF TRUTH FOR WINDOWING
    this.windowStart = 0
    if (this.partBasedMode) {
      // Part-based mode: window is set to current part boundaries
      this.windowEnabled = true
      this.initializeWindowForCurrentPart()
    } else if (opts.windowEnabled === false) {
      // Force disable windowing
      this.windowEnabled = false
      this.windowEnd = numBlocks
    } else if (data.length < WINDOW_ENABLE_THRESHOLD) {
      this.windowEnabled = false
      this.windowEnd = numBlocks
    } else {
      // Files >= 200KB: Use segment-based windowing with fixed 200KB segments
      this.windowEnabled = true
      this.windowEnd = Math.min(getSegmentSizeBlocks(this.blockSize), numBlocks)
    }

  }

  /**
   * Initialize window boundaries for the current part
   */
  private initializeWindowForCurrentPart(): void {
    if (!this.partBasedMode) return

    const partStartByte = this.currentPartIndex * this.partSize
    const partEndByte = Math.min((this.currentPartIndex + 1) * this.partSize, this.originalData.length)

    this.windowStart = Math.floor(partStartByte / this.blockSize)
    this.windowEnd = Math.ceil(partEndByte / this.blockSize)
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
   * Move to the next part and update window boundaries
   * Returns true if moved to next part, false if already at last part
   */
  moveToNextPart(): boolean {
    if (!this.partBasedMode) return false
    if (this.currentPartIndex >= this.totalParts - 1) return false

    this.currentPartIndex++
    this.initializeWindowForCurrentPart()

    // Reset targeted mode for new part
    this.targetedMode = false
    this.receivedBlocks.clear()
    this.skipBlocksBelow = this.windowStart

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

  getStats(): FountainEncoderStats {
    return {
      producedChunks: this.chunkCounter,
      avgDegree: this.chunkCounter > 0 ? this.sumDegrees / this.chunkCounter : 0,
      uniqueBlockCoverage: this.sourceBlocks.length > 0 ? this.seenBlocks.size / this.sourceBlocks.length : 0,
      windowCoverage: this.windowEnabled ? (this.windowEnd - this.windowStart) / this.sourceBlocks.length : 1.0
    }
  }

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
   * Set the threshold below which blocks should be skipped
   * This represents the first block index that should be considered for chunk generation
   */
  setSkipBlocksBelow(threshold: number): void {
    this.skipBlocksBelow = Math.max(0, Math.min(threshold, this.sourceBlocks.length))
  }

  /**
   * Expand the window by the specified number of blocks or the adaptive baseline increment if not provided.
   * @param expansionBlocks - Optional number of blocks to expand by. If not provided, uses the baseline (segment * threshold).
   * Returns true if expansion occurred, false if already at end
   */
  expandWindow(expansionBlocks?: number): boolean {
    if (this.windowEnd >= this.sourceBlocks.length) {
      return false // Already at the end
    }

    const defaultExpansion = getBaselineWindowExpansionBlocks(this.blockSize)
    let expansion: number
    if (expansionBlocks !== undefined) {
      const coerced = Math.ceil(expansionBlocks)
      expansion = coerced > 0 ? coerced : defaultExpansion
    } else {
      expansion = defaultExpansion
    }

    this.windowEnd = Math.min(this.windowEnd + expansion, this.sourceBlocks.length)
    return true
  }

  /**
   * Get current window information
   */
  getWindowInfo(): {
    windowEnabled: boolean
    windowStart: number
    windowEnd: number
    windowSize: number
    totalBlocks: number
    isWindowComplete: boolean
    skipBlocksBelow: number
    currentSegment: number
    totalSegments: number
    segmentProgress: number
    segmentSizeBlocks: number
  } {
    const { segmentSizeBlocks, totalSegments, currentSegment } = this.getSegmentMetrics()
    // TODO: segmentProgress should be calculated based on receiver feedback (decoded blocks within current segment)
    // For now, set to 0 as encoder doesn't track decoded blocks
    const segmentProgress = 0

    return {
      windowEnabled: this.windowEnabled,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      windowSize: this.windowEnd - this.windowStart,
      totalBlocks: this.sourceBlocks.length,
      isWindowComplete: this.windowEnd >= this.sourceBlocks.length,
      skipBlocksBelow: this.skipBlocksBelow,
      currentSegment,
      totalSegments,
      segmentProgress,
      segmentSizeBlocks
    }
  }

  /**
   * Get segment metrics for segment-based windowing calculations
   */
  private getSegmentMetrics(): { segmentSizeBlocks: number, totalSegments: number, currentSegment: number } {
    const segmentSizeBlocks = getSegmentSizeBlocks(this.blockSize)
    const totalSegments = Math.ceil(this.sourceBlocks.length / segmentSizeBlocks)
    const currentSegment = Math.min(totalSegments, Math.ceil(this.windowEnd / segmentSizeBlocks))
    return { segmentSizeBlocks, totalSegments, currentSegment }
  }

  /**
   * Get blocks in the current window
   */
  private getWindowBlocks(): number[] {
    const windowBlocks = this.windowEnabled
      ? Array.from({ length: this.windowEnd - this.windowStart }, (_, i) => i + this.windowStart)
      : Array.from({ length: this.sourceBlocks.length }, (_, i) => i)

    // Apply skip threshold: filter out blocks below the contiguous prefix
    return windowBlocks.filter(blockIdx => blockIdx >= this.skipBlocksBelow)
  }

  /**
   * Get missing blocks that receiver still needs
   */
  private getMissingBlocks(): number[] {

    const windowBlocks = this.getWindowBlocks()

    // Then apply targeted mode filtering
    if (!this.targetedMode) {
      return windowBlocks
    }

    const missing: number[] = []
    for (const blockIdx of windowBlocks) {
      if (!this.receivedBlocks.has(blockIdx)) {
        missing.push(blockIdx)
      }
    }
    return missing
  }

  generateChunk(): FountainChunk {
    const seed = this.chunkCounter++
    const rng = new SeededRandom(seed)

    // In targeted mode, prefer missing blocks
    let missingBlocks = this.getMissingBlocks()
    let availableBlocks = missingBlocks.length > 0 ? missingBlocks : this.getWindowBlocks()

    // If no available blocks after applying skip threshold, expand window or ignore skip
    if (availableBlocks.length === 0) {
      // Automatically expand the window until it covers skipBlocksBelow
      while (this.windowEnd < this.skipBlocksBelow && this.expandWindow()) {
        // Expansion happens in the condition
      }

      // Recalculate after expansion
      const windowBlocks = this.getWindowBlocks()
      missingBlocks = this.targetedMode ? windowBlocks.filter(idx => !this.receivedBlocks.has(idx)) : windowBlocks
      availableBlocks = missingBlocks.length > 0 ? missingBlocks : windowBlocks

      // If still empty, temporarily ignore the skip filter
      if (availableBlocks.length === 0) {
        const fullWindowBlocks = this.windowEnabled
          ? Array.from({ length: this.windowEnd - this.windowStart }, (_, i) => i + this.windowStart)
          : Array.from({ length: this.sourceBlocks.length }, (_, i) => i)
        availableBlocks = this.targetedMode ? fullWindowBlocks.filter(idx => !this.receivedBlocks.has(idx)) : fullWindowBlocks
      }
    }

    const finalAvailableBlocks = availableBlocks

    // Adjust degree based on how many blocks are left
    let degree = sampleDegree(rng, this.degreeDist, this.samplerOpts)

    // In targeted mode with few missing blocks, use lower degrees for efficiency
    if (this.targetedMode && missingBlocks.length > 0 && missingBlocks.length < 10) {
      degree = Math.min(degree, Math.max(1, Math.ceil(missingBlocks.length / 2)))
    }

    // Cap degree at available blocks
    degree = Math.min(degree, finalAvailableBlocks.length)

    const indices: number[] = []
    const selected = new Set<number>()

    // Sample from available (missing) blocks
    while (selected.size < degree) {
      const idx = finalAvailableBlocks[Math.floor(rng.next() * finalAvailableBlocks.length)]
      if (!selected.has(idx)) {
        selected.add(idx)
        indices.push(idx)
      }
    }

    // In-place XOR accumulation to avoid TypedArray generic variance issues
    const encoded = new Uint8Array(this.blockSize)
    for (const idx of indices) {
      const block = this.sourceBlocks[idx]
      for (let i = 0; i < this.blockSize; i++) {
        encoded[i] ^= block[i]
      }
      this.seenBlocks.add(idx)
    }

    this.sumDegrees += degree
    return {
      seed,
      degree,
      indices: indices.sort((a, b) => a - b),
      data: encoded
    }
  }

  generateChunks(count: number): FountainChunk[] {
    const out: FountainChunk[] = []
    for (let i = 0; i < count; i++) out.push(this.generateChunk())
    return out
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
