export const DEFAULT_BLOCK_SIZE = 400
export const WINDOW_ENABLE_THRESHOLD = 200 * 1024
export const WINDOW_HALF_THRESHOLD = 256 * 1024
export const WINDOW_MAX_BYTES = 100 * 1024

// Targeted mode activation threshold (byte-based, converted to blocks at runtime)
// When missing blocks <= this threshold, receiver switches to targeted mode
// Fountain code handles 50-100 missing blocks efficiently without targeting
// Targeted mode is most effective for the "tail problem" (few scattered blocks)
const TARGETED_MODE_MAX_MISSING_BYTES = 10 * DEFAULT_BLOCK_SIZE // 4000 bytes

// File size threshold for feedback (byte-based, converted to blocks at runtime)
const FEEDBACK_FILE_SIZE_THRESHOLD_BYTES = 50 * DEFAULT_BLOCK_SIZE // 20000 bytes

export function getTargetedModeMaxMissingBlocks(blockSize: number): number {
  return Math.ceil(TARGETED_MODE_MAX_MISSING_BYTES / blockSize)
}

export function getFeedbackFileSizeThresholdBlocks(blockSize: number): number {
  return Math.ceil(FEEDBACK_FILE_SIZE_THRESHOLD_BYTES / blockSize)
}

