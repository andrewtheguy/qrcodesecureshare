export const DEFAULT_BLOCK_SIZE = 400
// Determines when windowing activates (files > 200KB)
export const WINDOW_ENABLE_THRESHOLD = 200 * 1024

// Determines when to use half-file vs segment-based windowing (files 200-256KB use 50% of file, files > 256KB use segment-based)
export const WINDOW_HALF_THRESHOLD = 256 * 1024

// Maintained for backward compatibility and currently aligns with SEGMENT_SIZE_BYTES
export const WINDOW_MAX_BYTES = 100 * 1024

// Segment-based windowing strategy: treats large files as multiple small file segments
// Uses fixed increments instead of percentage-based expansion for QR code transfers
// where manual camera scanning makes time-based metrics irrelevant
// Initial window size: 100KB ≈ 250 blocks at 400 bytes/block
// Feedback trigger: 50% of window must be decoded (125 blocks) before feedback
// Prevents too-frequent early feedback and excessive window expansion for larger files
export const SEGMENT_SIZE_BYTES = 100 * 1024

// Fixed increment for window expansion: 50KB ≈ 125 blocks at 400 bytes/block
// Maintains consistent expansion rate regardless of current window size
export const WINDOW_EXPANSION_SIZE_BYTES = 50 * 1024

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

