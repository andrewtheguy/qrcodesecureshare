export const DEFAULT_BLOCK_SIZE = 1000

// Targeted mode activation threshold - triggers when ≤10 blocks remain missing.
// Used only for the final cleanup phase in part-based transfers.
const TARGETED_MODE_MAX_MISSING_BLOCKS = 10

// Targeted mode feature flag - temporarily disabled for part-based transfer testing
export const ENABLE_TARGETED_MODE = false

// Part-based transfer sizes (in bytes) for feedback mode
// User can select which part size to use for splitting large files
export const PART_SIZE_OPTIONS = {
  TINY: 32 * 1024,    // 32KB (for testing)
  SMALL: 256 * 1024,  // 256KB
  MEDIUM: 512 * 1024, // 512KB
  LARGE: 1024 * 1024, // 1MB (1024KB)
} as const

export type PartSizeOption = keyof typeof PART_SIZE_OPTIONS

export function getTargetedModeMaxMissingBlocks(): number {
  return TARGETED_MODE_MAX_MISSING_BLOCKS
}
