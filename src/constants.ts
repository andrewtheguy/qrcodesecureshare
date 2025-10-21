// Magic header to identify encrypted file download QR codes
export const ENCRYPTED_FILE_MAGIC = 'ENCFILE_v1:'

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

// QR Code capacity mapping based on error correction level
// For a 400px width QR code with binary data encoding (ISO-8859-1)
// Based on QR Code version 40 (177x177 modules) capacity estimates
export const QR_CAPACITY_MAP: Record<'L' | 'M' | 'Q' | 'H', { base: number, safetyMargin: number }> = {
  'L': { base: 2953, safetyMargin: 0.6 }, // Low ECC (7% recovery) - ~1772 bytes usable
  'M': { base: 2331, safetyMargin: 0.6 }, // Medium ECC (15% recovery) - ~1399 bytes usable
  'Q': { base: 1663, safetyMargin: 0.6 }, // Quartile ECC (25% recovery) - ~998 bytes usable
  'H': { base: 1273, safetyMargin: 0.6 }  // High ECC (30% recovery) - ~764 bytes usable
}

/**
 * Derives dynamic QR capacity based on error correction level
 * @param eccLevel - Error correction level (L, M, Q, H)
 * @param canvasWidth - QR code canvas width in pixels (default 400)
 * @returns Maximum safe data size in bytes
 */
export const deriveQRCapacity = (eccLevel: 'L' | 'M' | 'Q' | 'H', canvasWidth: number = 400): number => {
  const capacityInfo = QR_CAPACITY_MAP[eccLevel]

  // Scale capacity based on canvas width (linear approximation)
  // 400px is our baseline; adjust if different canvas size
  const scaleFactor = canvasWidth / 400
  const scaledBase = Math.floor(capacityInfo.base * scaleFactor)

  // Apply safety margin to ensure reliable encoding
  const safeCapacity = Math.floor(scaledBase * capacityInfo.safetyMargin)

  return safeCapacity
}