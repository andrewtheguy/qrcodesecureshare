export const DEFAULT_BLOCK_SIZE = 600
export const WINDOW_ENABLE_THRESHOLD = 200 * 1024
export const WINDOW_HALF_THRESHOLD = 256 * 1024
export const WINDOW_MAX_BYTES = 128 * 1024

// Defragmentation thresholds
export const DEFRAG_MAX_TARGETS = 10
export const DEFRAG_MAX_MISSING_COUNT = 10

// Prefix-window defragmentation parameters
export const DEFRAG_PREFIX_WINDOW_BLOCKS = 100
export const DEFRAG_PREFIX_WINDOW_RATIO = 0.15
export const DEFRAG_MIN_OVERALL_PROGRESS = 0.20

// Targeted mode activation threshold
// When missing blocks <= this threshold, receiver switches to targeted mode
// Fountain code handles 50-100 missing blocks efficiently without targeting
// Targeted mode is most effective for the "tail problem" (few scattered blocks)
export const TARGETED_MODE_MAX_MISSING_BLOCKS = 5
