export const DEFAULT_BLOCK_SIZE = 400
export const WINDOW_ENABLE_THRESHOLD = 200 * 1024
export const WINDOW_HALF_THRESHOLD = 256 * 1024
export const WINDOW_MAX_BYTES = 100 * 1024

// Defragmentation thresholds (byte-based, converted to blocks at runtime)
const DEFRAG_MAX_TARGETS_BYTES = 10 * DEFAULT_BLOCK_SIZE // 4000 bytes
const DEFRAG_MAX_MISSING_COUNT_BYTES = 10 * DEFAULT_BLOCK_SIZE // 4000 bytes

// Prefix-window defragmentation parameters
const DEFRAG_PREFIX_WINDOW_BYTES = 150 * DEFAULT_BLOCK_SIZE // 60000 bytes
export const DEFRAG_PREFIX_WINDOW_RATIO = 0.15
export const DEFRAG_MIN_OVERALL_PROGRESS = 0.20

// Targeted mode activation threshold (byte-based, converted to blocks at runtime)
// When missing blocks <= this threshold, receiver switches to targeted mode
// Fountain code handles 50-100 missing blocks efficiently without targeting
// Targeted mode is most effective for the "tail problem" (few scattered blocks)
const TARGETED_MODE_MAX_MISSING_BYTES = 10 * DEFAULT_BLOCK_SIZE // 4000 bytes

// File size threshold for feedback (byte-based, converted to blocks at runtime)
const FEEDBACK_FILE_SIZE_THRESHOLD_BYTES = 50 * DEFAULT_BLOCK_SIZE // 20000 bytes

// Helper functions to convert byte thresholds to block counts based on actual block size
export function getDefragMaxTargets(blockSize: number): number {
  return Math.ceil(DEFRAG_MAX_TARGETS_BYTES / blockSize)
}

export function getDefragMaxMissingCount(blockSize: number): number {
  return Math.ceil(DEFRAG_MAX_MISSING_COUNT_BYTES / blockSize)
}

export function getDefragPrefixWindowBlocks(blockSize: number): number {
  return Math.ceil(DEFRAG_PREFIX_WINDOW_BYTES / blockSize)
}

export function getTargetedModeMaxMissingBlocks(blockSize: number): number {
  return Math.ceil(TARGETED_MODE_MAX_MISSING_BYTES / blockSize)
}

export function getFeedbackFileSizeThresholdBlocks(blockSize: number): number {
  return Math.ceil(FEEDBACK_FILE_SIZE_THRESHOLD_BYTES / blockSize)
}

