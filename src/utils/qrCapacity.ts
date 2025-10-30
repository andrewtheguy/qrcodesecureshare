/**
 * QR Code Capacity Utilities
 *
 * This module handles QR code data capacity calculations for fountain-coded transfers.
 *
 * IMPORTANT: QR code capacity is determined by:
 * - QR Version (we use version 40 = 177×177 modules = largest QR code)
 * - Error Correction Level (L, M, Q, H)
 *
 * QR capacity is INDEPENDENT of rendering size (canvas width/height in pixels).
 * A 400px QR code and an 800px QR code hold the SAME amount of data.
 * Larger rendering only improves scanability, not capacity.
 */

// QR Version 40 capacity in bytes for each error correction level (byte mode)
// Source: ISO/IEC 18004:2015 QR Code specification
export const QR_VERSION_40_CAPACITY = {
  'L': 2953,  // Low ECC (7% recovery capability)
  'M': 2331,  // Medium ECC (15% recovery capability)
  'Q': 1663,  // Quartile ECC (25% recovery capability)
  'H': 1273   // High ECC (30% recovery capability)
} as const

// Safety margin applied to theoretical capacity to ensure reliable encoding
// We use 60% of theoretical capacity to account for:
// - Chunk overhead (magic bytes, seed, indices, checksum)
// - Part metadata (when enabled)
// - Encoding inefficiencies
const SAFETY_MARGIN = 0.6

/**
 * Calculate the safe usable capacity for a QR code based on error correction level.
 *
 * Returns the maximum number of bytes that can be safely encoded in a
 * QR Version 40 code with the specified error correction level.
 *
 * @param eccLevel - Error correction level (L, M, Q, H)
 * @returns Maximum safe data size in bytes
 *
 * @example
 * ```typescript
 * const capacity = getQRCapacity('L')  // Returns ~1772 bytes
 * const capacity = getQRCapacity('H')  // Returns ~764 bytes
 * ```
 */
export function getQRCapacity(eccLevel: 'L' | 'M' | 'Q' | 'H'): number {
  const theoreticalCapacity = QR_VERSION_40_CAPACITY[eccLevel]
  const safeCapacity = Math.floor(theoreticalCapacity * SAFETY_MARGIN)

  return safeCapacity
}

/**
 * Get detailed capacity information for all error correction levels.
 * Useful for debugging and capacity planning.
 *
 * @returns Object with capacity info for each ECC level
 */
export function getAllQRCapacities() {
  const levels = ['L', 'M', 'Q', 'H'] as const

  return levels.map(level => ({
    level,
    theoretical: QR_VERSION_40_CAPACITY[level],
    safe: getQRCapacity(level),
    safetyMargin: SAFETY_MARGIN
  }))
}
