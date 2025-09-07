// Magic header to identify encrypted file download QR codes
export const ENCRYPTED_FILE_MAGIC = 'ENCFILE_v1:'

// Interface for encrypted file QR data
export interface EncryptedFileData {
  url: string
  passphrase: string
  filename: string
  uploadedAt?: string
}