/**
 * Fountain Code Implementation (LT Codes - Luby Transform)
 *
 * This implementation allows receivers to reconstruct the original data
 * without needing to receive all chunks. Typically requires ~105-110% of
 * original chunks due to redundancy.
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

// Robust Soliton distribution for degree selection
function robustSolitonDistribution(k: number, c: number = 0.1, delta: number = 0.5): number[] {
  const R = c * Math.log(k / delta) * Math.sqrt(k)
  const probabilities: number[] = new Array(k).fill(0)

  // Ideal Soliton distribution
  probabilities[0] = 1 / k
  for (let i = 2; i <= k; i++) {
    probabilities[i - 1] = 1 / (i * (i - 1))
  }

  // Add robust component
  const tau: number[] = new Array(k).fill(0)
  for (let i = 1; i <= k / R - 1; i++) {
    tau[i - 1] = R / (i * k)
  }
  tau[Math.floor(k / R) - 1] = R * Math.log(R / delta) / k

  // Normalize
  const beta = tau.reduce((sum, val) => sum + val, 0) + probabilities.reduce((sum, val) => sum + val, 0)
  for (let i = 0; i < k; i++) {
    probabilities[i] = (probabilities[i] + tau[i]) / beta
  }

  return probabilities
}

// Select degree based on distribution
function selectDegree(probabilities: number[], rng: SeededRandom): number {
  const r = rng.next()
  let cumulative = 0
  for (let i = 0; i < probabilities.length; i++) {
    cumulative += probabilities[i]
    if (r <= cumulative) {
      return i + 1
    }
  }
  return probabilities.length
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

export class FountainEncoder {
  private sourceBlocks: Uint8Array[]
  private blockSize: number
  private degreeDistribution: number[]
  private metadata: FountainMetadata
  private chunkCounter: number = 0

  constructor(data: Uint8Array, blockSize: number = 1200, metadata: Omit<FountainMetadata, 'totalSourceBlocks' | 'blockSize'>) {
    this.blockSize = blockSize
    const numBlocks = Math.ceil(data.length / blockSize)

    // Split data into source blocks
    this.sourceBlocks = []
    for (let i = 0; i < numBlocks; i++) {
      const start = i * blockSize
      const end = Math.min(start + blockSize, data.length)
      const block = new Uint8Array(blockSize)
      block.set(data.slice(start, end))
      this.sourceBlocks.push(block)
    }

    this.degreeDistribution = robustSolitonDistribution(numBlocks)
    this.metadata = {
      ...metadata,
      totalSourceBlocks: numBlocks,
      blockSize
    }
  }

  getMetadata(): FountainMetadata {
    return this.metadata
  }

  // Generate next fountain-coded chunk
  generateChunk(): FountainChunk {
    const seed = this.chunkCounter++
    const rng = new SeededRandom(seed)

    // Select degree (how many blocks to combine)
    const degree = selectDegree(this.degreeDistribution, rng)

    // Select which blocks to combine
    const indices: number[] = []
    const selectedBlocks: Set<number> = new Set()

    while (selectedBlocks.size < degree) {
      const idx = Math.floor(rng.next() * this.sourceBlocks.length)
      if (!selectedBlocks.has(idx)) {
        selectedBlocks.add(idx)
        indices.push(idx)
      }
    }

    // XOR selected blocks together
    let encodedData = new Uint8Array(this.blockSize)
    for (const idx of indices) {
      encodedData = xorArrays(encodedData, this.sourceBlocks[idx])
    }

    return {
      seed,
      degree,
      indices: indices.sort((a, b) => a - b),
      data: encodedData
    }
  }

  // Generate multiple chunks at once
  generateChunks(count: number): FountainChunk[] {
    const chunks: FountainChunk[] = []
    for (let i = 0; i < count; i++) {
      chunks.push(this.generateChunk())
    }
    return chunks
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
}
