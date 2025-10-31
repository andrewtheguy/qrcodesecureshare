export const DEFAULT_BLOCK_SIZE = 1000

// Part-based transfer sizes (in bytes) for feedback mode
// User can select which part size to use for splitting large files
export const PART_SIZE_OPTIONS = {
  TINY: 32 * 1024,    // 32KB (for testing)
  SMALL: 256 * 1024,  // 256KB
  MEDIUM: 512 * 1024, // 512KB
  LARGE: 1024 * 1024, // 1MB (1024KB)
} as const

export type PartSizeOption = keyof typeof PART_SIZE_OPTIONS
