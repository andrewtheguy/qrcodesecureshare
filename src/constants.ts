// Magic header to identify encrypted file download QR codes
export const ENCRYPTED_FILE_MAGIC = 'ENCFILE_v1:'

// Magic header to identify WebRTC transfer QR codes
export const WEBRTC_TRANSFER_MAGIC = 'WEBRTC_v1:'

// Magic header to identify offline file transfer metadata QR codes
export const OFFLINE_METADATA_MAGIC = 'OFFMETA_v1:'

// Interface for encrypted file QR data
export interface EncryptedFileData {
  url: string
  passphrase: string
  filename: string
  uploadedAt?: string
}

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