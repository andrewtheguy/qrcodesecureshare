export const DEFAULT_BLOCK_SIZE = 400

// Segment-based windowing strategy: treats large files as multiple small file segments
// Uses fixed increments instead of percentage-based expansion for QR code transfers
// with the sender acting as the single source of truth for the window parameters
// Initial window size: 200KB ≈ 500 blocks at 400 bytes/block
// Feedback trigger: 40% of window must be decoded (200 blocks) before feedback
// Prevents too-frequent early feedback and excessive window expansion for larger files
const SEGMENT_SIZE_BYTES = 200 * 1024

// Determines when windowing activates (files > 200KB)
export const WINDOW_ENABLE_THRESHOLD = SEGMENT_SIZE_BYTES

// Targeted mode activation threshold - triggers when ≤10 blocks remain missing.
// Used only for the final cleanup phase; targeted mode never performs window expansion.
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

export function getSegmentSizeBlocks(blockSize: number): number {
  return Math.ceil(SEGMENT_SIZE_BYTES / blockSize)
}

// Adaptive window threshold algorithm constants
// The baseline threshold (40%) is the default percentage at which feedback is first triggered
// The adaptive algorithm adjusts this threshold based on the last triggered percentage to prevent premature feedback requests
// Formula: adaptiveThreshold = BASELINE + (lastTriggeredPercentage - BASELINE)
// Example: If last feedback was triggered at 95%, next trigger should be at 95% (40% + 55% compensation)
export const WINDOW_BASELINE_THRESHOLD = 0.4 // 40% - baseline trigger point

/**
 * Calculates the minimum expansion increment (in blocks) derived from the segment size and baseline threshold.
 * This ensures any default expansion is expressed as a fraction of the segment size instead of a fixed byte limit.
 */
export function getBaselineWindowExpansionBlocks(blockSize: number): number {
  const segmentSizeBlocks = getSegmentSizeBlocks(blockSize)
  return Math.max(1, Math.ceil(segmentSizeBlocks * WINDOW_BASELINE_THRESHOLD))
}

/**
 * Calculates dynamic window expansion size based on receiver's progress and first missing block position.
 *
 * This function implements a compensation mechanism to ensure the next window doesn't come too fast.
 * The formula is: expansionSize = segmentSize * (40% + extraPercent)
 *
 * The extraPercent compensates for work already done:
 * - If all blocks are contiguous up to 40% of the window, extra = 0%, expand by 200KB * 40%
 * - If there's a gap at 15% but overall progress is 40%, extra = 15%, expand by 200KB * 55%
 *
 * @param firstMissingBlock - The first block index that hasn't been decoded (indicates contiguous progress)
 * @param windowStart - Current window start position (block index)
 * @param windowEnd - Current window end position (block index)
 * @param windowSize - Size of current window in blocks
 * @param overallProgressPercent - Overall file decode progress (0-100)
 * @param blockSize - Size of each block in bytes
 * @param totalBlocks - Total number of blocks in the file
 * @returns Object containing expansion size in blocks and calculation details
 *
 * @example
 * // All blocks contiguous at 40% of window
 * calculateWindowExpansionSize(200, 0, 500, 500, 40, 400, 1000)
 * // Returns: { expansionBlocks: 200, effectivePercent: 0.4, extraPercent: 0, contiguousDecoded: 200 }
 *
 * @example
 * // Gap at 15% but overall progress is 40%
 * calculateWindowExpansionSize(75, 0, 500, 500, 40, 400, 1000)
 * // Returns: { expansionBlocks: 275, effectivePercent: 0.15, extraPercent: 0.25, contiguousDecoded: 75 }
 */
export function calculateWindowExpansionSize(
  firstMissingBlock: number,
  windowStart: number,
  windowEnd: number,
  windowSize: number,
  overallProgressPercent: number,
  blockSize: number,
  totalBlocks: number
): {
  expansionBlocks: number;
  effectivePercent: number;
  extraPercent: number;
  contiguousDecoded: number;
} {
  // Calculate contiguous decoded blocks within current window
  const contiguousDecoded = Math.max(0, Math.min(firstMissingBlock, windowEnd) - windowStart);

  // Derive currentProgressBlock from overallProgressPercent
  const currentProgressBlock = Math.round((overallProgressPercent / 100) * totalBlocks);

  // Compute bounds for effective percentage calculation
  const start = windowStart;
  const end = windowEnd;
  const firstRelevant = Math.max(start, Math.min(firstMissingBlock, end));

  // Compute effective blocks from firstRelevant to currentProgressBlock
  const effectiveBlocks = Math.max(0, Math.min(currentProgressBlock, end) - firstRelevant);

  // Calculate effective percentage within window
  const effectivePercent = windowSize > 0 ? (effectiveBlocks / windowSize) : 0;

  // Calculate extra percentage to compensate for work already done
  const extraPercent = Math.min(
    Math.abs(WINDOW_BASELINE_THRESHOLD - effectivePercent),
    0.6
  );

  // Get segment size in blocks (200KB converted to blocks)
  const segmentSizeBlocks = getSegmentSizeBlocks(blockSize);

  // Calculate expansion size in blocks
  const expansionBlocks = Math.ceil(segmentSizeBlocks * (WINDOW_BASELINE_THRESHOLD + extraPercent));

  return {
    expansionBlocks,
    effectivePercent,
    extraPercent,
    contiguousDecoded,
  };
}
