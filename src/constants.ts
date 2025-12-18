// Magic header to identify offline file transfer metadata QR codes
export const OFFLINE_METADATA_MAGIC = 'OFFMETA_v1:'

// Magic header to identify compressed text QR codes (binary payload)
export const COMPRESSED_TEXT_MAGIC = 'CMPQR1:'

// Shared QR options for non-data QR codes (feedback, ACK, etc.)
export const NON_DATA_QR_OPTIONS = {
  width: 400,
  margin: 2,
  errorCorrectionLevel: 'M' as const,
  color: {
    dark: '#000',
    light: '#FFF'
  }
}
