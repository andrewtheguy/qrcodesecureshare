/**
 * Shared utility functions for fountain code operations
 */

/**
 * Calculate the first missing block index in a sequence of decoded blocks.
 * This represents the contiguous prefix of decoded blocks from index 0.
 *
 * @param decodedBlockIndices - Sorted array of decoded block indices
 * @returns The index of the first missing block in the sequence
 *
 * @example
 * calculateFirstMissingBlock([0, 1, 2, 4, 5]) // returns 3
 * calculateFirstMissingBlock([0, 1, 2, 3, 4]) // returns 5
 * calculateFirstMissingBlock([1, 2, 3]) // returns 0
 */
export function calculateFirstMissingBlock(decodedBlockIndices: number[]): number {
  // Find the first index where the sequence breaks
  for (let i = 0; i < decodedBlockIndices.length; i++) {
    if (decodedBlockIndices[i] !== i) {
      return i
    }
  }

  // If all blocks from 0 to length-1 are contiguous, return the length
  return decodedBlockIndices.length
}
