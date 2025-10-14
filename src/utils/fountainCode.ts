import { WINDOW_ENABLE_THRESHOLD, WINDOW_HALF_THRESHOLD, WINDOW_MAX_BYTES } from './fountainConfig'

/**
 * Fountain (LT) Code Implementation – Tuned Version (NOT backward compatible)
 *
 * Key changes vs previous version:
 *  - Uses configurable robust soliton with tighter failure probability (delta=0.01)
 *  - Adds degree "doping" (forced low-degree symbols) to maintain healthy ripple
 *  - Adaptive max degree: min(50, max(8, round(3 * sqrt(k))))
 *  - Renormalizes distribution when truncated by max degree
 *  - Exposes tuning + runtime stats (avg degree, produced chunks, unique indices coverage)
 *  - Simplified generateChunk(): no parameter – encoder owns all tuning
 *
 * Recommended single-session max file size with default blockSize=600 bytes:
 *   Green zone: ≤ ~200 KB (k ≲ 334)
 *   Yellow zone: 200–250 KB (k 334–417) – still fine
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
}

export interface FountainEncoderOptions {
  blockSize?: number
  c?: number          // robust soliton parameter
  delta?: number      // failure probability target
  maxDegree?: number  // hard ceiling (auto chosen if omitted)
  degree1Rate?: number
  lowDegreeRate?: number
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
  private windowStart: number
  private windowEnd: number
  private windowEnabled: boolean
  private skipBlocksBelow: number = 0
  private defragTargets: Set<number> = new Set()
  private defragMode: boolean = false
  private defragCompletedTargets: number[] = []

  constructor(
    data: Uint8Array,
    metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>,
    opts: FountainEncoderOptions = {}
  ) {
    this.blockSize = opts.blockSize ?? 600
    const numBlocks = Math.ceil(data.length / this.blockSize)

    for (let i = 0; i < numBlocks; i++) {
      const start = i * this.blockSize
      const end = Math.min(start + this.blockSize, data.length)
      const block = new Uint8Array(this.blockSize)
      block.set(data.slice(start, end))
      this.sourceBlocks.push(block)
    }

    const adaptiveMaxDegree = opts.maxDegree ?? Math.min(50, Math.max(8, Math.round(3 * Math.sqrt(numBlocks))))
    const c = opts.c ?? 0.2
    const delta = opts.delta ?? 0.01
    this.degreeDist = buildDegreeDistribution(numBlocks, c, delta, adaptiveMaxDegree)
    this.samplerOpts = {
      degree1Rate: opts.degree1Rate ?? 0.08,
      lowDegreeRate: opts.lowDegreeRate ?? 0.15
    }

    this.metadata = { ...metadata, totalSourceBlocks: numBlocks, blockSize: this.blockSize }

    // Initialize window state
    this.windowStart = 0
    if (data.length < WINDOW_ENABLE_THRESHOLD) {
      this.windowEnabled = false
      this.windowEnd = numBlocks
    } else if (data.length >= WINDOW_ENABLE_THRESHOLD && data.length <= WINDOW_HALF_THRESHOLD) {
      this.windowEnabled = true
      this.windowEnd = Math.ceil(numBlocks * 0.5)
    } else {
      this.windowEnabled = true
      this.windowEnd = Math.min(Math.ceil(WINDOW_MAX_BYTES / this.blockSize), numBlocks)
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
   * Set defragmentation targets - specific blocks to prioritize
   */
  setDefragTargets(blockIndices: number[]): void {
    this.defragTargets = new Set(blockIndices.filter(idx => idx >= 0 && idx < this.sourceBlocks.length))
    this.defragMode = this.defragTargets.size > 0
    this.defragCompletedTargets = []
  }

  /**
   * Expand the window by 50% of current window size
   * Returns true if expansion occurred, false if already at end
   */
  expandWindow(): boolean {
    if (this.windowEnd >= this.sourceBlocks.length) {
      return false // Already at the end
    }

    const currentSize = this.windowEnd - this.windowStart
    const expansion = Math.ceil(currentSize * 0.5)
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
  } {
    return {
      windowEnabled: this.windowEnabled,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      windowSize: this.windowEnd - this.windowStart,
      totalBlocks: this.sourceBlocks.length,
      isWindowComplete: this.windowEnd >= this.sourceBlocks.length,
      skipBlocksBelow: this.skipBlocksBelow
    }
  }

  /**
   * Get defragmentation state information
   */
  getDefragInfo(): { defragMode: boolean, defragTargets: number[], targetCount: number, completedTargets: number[] } {
    return {
      defragMode: this.defragMode,
      defragTargets: Array.from(this.defragTargets),
      targetCount: this.defragTargets.size,
      completedTargets: [...this.defragCompletedTargets]
    }
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
    // Defrag mode takes highest priority
    if (this.defragMode && this.defragTargets.size > 0) {
      const defragMissing = Array.from(this.defragTargets).filter(idx => !this.receivedBlocks.has(idx))
      if (defragMissing.length > 0) {
        return defragMissing
      }
      // All defrag targets decoded - track completed targets but don't auto-exit
      // Sender will explicitly signal completion via sender feedback QR
      this.defragCompletedTargets = Array.from(this.defragTargets)
    }

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

    // In defrag mode with few targets, use even lower degrees
    if (this.defragMode && this.defragTargets.size > 0 && this.defragTargets.size <= 5) {
      degree = Math.min(degree, 2)
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
   * Check if defragmentation is complete
   */
  isDefragComplete(): boolean {
    return this.defragMode && this.defragTargets.size > 0 && this.defragCompletedTargets.length === this.defragTargets.size
  }

  /**
   * Exit defragmentation mode and return completed targets
   */
  exitDefragMode(): number[] {
    const completed = [...this.defragCompletedTargets]
    this.defragMode = false
    this.defragTargets.clear()
    this.defragCompletedTargets = []
    return completed
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

  constructor(metadata: FountainMetadata) {
    this.metadata = metadata
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
    return this.isDecoded
  }

  getMetadata(): FountainMetadata {
    return this.metadata
  }

  // Reconstruct the original data
  getDecodedData(): Uint8Array | null {
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
   * Rollback to a specific block index (discard blocks >= blockIdx)
   */
  rollbackToBlock(blockIdx: number): void {
    // Purge receivedChunks that reference indices >= the rollback index
    this.receivedChunks = this.receivedChunks.filter(chunk =>
      !chunk.indices.some(idx => idx >= blockIdx)
    )

    const blocksToRemove: number[] = []
    for (const [idx] of this.decodedBlocks) {
      if (idx >= blockIdx) {
        blocksToRemove.push(idx)
      }
    }

    for (const idx of blocksToRemove) {
      this.decodedBlocks.delete(idx)
    }

    this.isDecoded = false
  }

  /**
   * Get rollback information for UI display
   */
  getRollbackInfo(): { canRollback: boolean, currentFirstMissing: number, decodedCount: number } {
    const decodedIndices = this.getDecodedBlockIndices()
    const firstMissing = decodedIndices.length > 0 ? decodedIndices[decodedIndices.length - 1] + 1 : 0

    return {
      canRollback: decodedIndices.length > 0,
      currentFirstMissing: firstMissing,
      decodedCount: decodedIndices.length
    }
  }
}
