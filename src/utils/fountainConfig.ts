export const DEFAULT_BLOCK_SIZE = 600
export const WINDOW_ENABLE_THRESHOLD = 200 * 1024
export const WINDOW_HALF_THRESHOLD = 256 * 1024
export const WINDOW_MAX_BYTES = 128 * 1024

// Defragmentation thresholds
export const DEFRAG_CRITICAL_PREFIX_SIZE = 100
export const DEFRAG_CRITICAL_PREFIX_RATIO = 0.15
export const DEFRAG_MAX_TARGETS = 10
export const DEFRAG_MIN_FIRST_MISSING = 20
export const DEFRAG_MAX_MISSING_COUNT = 10

// Targeted mode activation threshold
// When missing blocks <= this threshold, receiver switches to targeted mode
// Fountain code handles 50-100 missing blocks efficiently without targeting
// Targeted mode is most effective for the "tail problem" (few scattered blocks)
export const TARGETED_MODE_MAX_MISSING_BLOCKS = 10

// Sender feedback constants
export const SENDER_FEEDBACK_DISPLAY_DURATION = 5000
export const SENDER_FEEDBACK_AUTO_RESUME_DELAY = 1000