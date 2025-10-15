import QRCode from 'qrcode'
import { NON_DATA_QR_OPTIONS } from '@/constants'

// Shared main-thread function for non-data QR generation
export const generateNonDataQR = async (payload: object, opts?: {
  width?: number
  margin?: number
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  color?: {
    dark?: string
    light?: string
  }
}): Promise<string> => {
  try {
    const jsonString = JSON.stringify(payload)
    return await QRCode.toDataURL(jsonString, opts || NON_DATA_QR_OPTIONS)
  } catch (err) {
    console.error('Failed to generate non-data QR:', err)
    throw err
  }
}