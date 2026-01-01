import { writeBarcode } from 'zxing-wasm/full'
import { NON_DATA_QR_OPTIONS } from '@/constants'

/**
 * Generate a QR code from string or binary data and return as a data URL.
 * Drop-in replacement for QRCode.toDataURL() from the qrcode package.
 */
export async function generateQRDataURL(
  payload: string | Uint8Array,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  try {
    const binaryData = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload

    const result = await writeBarcode(binaryData, {
      format: 'QRCode',
      ecLevel: options?.errorCorrectionLevel || 'M',
      sizeHint: options?.width || 300,
      withQuietZones: true
    })

    if (result.error) {
      throw new Error(result.error)
    }

    const blob = result.image as Blob
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to convert blob to data URL'))
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.error('Failed to generate QR data URL:', err)
    throw err
  }
}

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
    const jsonBytes = new TextEncoder().encode(jsonString)

    const options = opts || NON_DATA_QR_OPTIONS
    const result = await writeBarcode(jsonBytes, {
      format: 'QRCode',
      ecLevel: options.errorCorrectionLevel || 'M',
      sizeHint: options.width || 400,
      withQuietZones: true
    })

    if (result.error) {
      throw new Error(result.error)
    }

    // Convert Blob to data URL
    const blob = result.image as Blob
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result as string)
      }
      reader.onerror = () => {
        reject(new Error('Failed to convert blob to data URL'))
      }
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.error('Failed to generate non-data QR:', err)
    throw err
  }
}