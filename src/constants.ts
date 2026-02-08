// Magic header to identify offline file transfer metadata QR codes
export const OFFLINE_METADATA_MAGIC = 'OFFMETA_v1:'

// Shared QR options for non-data QR codes (feedback, ACK, etc.)
export const NON_DATA_QR_OPTIONS = {
  margin: 1,
  errorCorrectionLevel: 'M' as const,
}

// Streamlined text fountain mode constants
export const TEXT_FOUNTAIN_TRIGGER_CHAR_COUNT = 1400
export const TEXT_FOUNTAIN_MAX_TEXT_BYTES = 64 * 1024
export const TEXT_FOUNTAIN_FPS = 8
export const TEXT_FOUNTAIN_AUTO_PAUSE_MIN_MS = 60_000
export const TEXT_FOUNTAIN_MAGIC = [0xF7, 0xA2] as const
export const TEXT_FOUNTAIN_VERSION = 1
