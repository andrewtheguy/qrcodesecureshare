import { writeBarcode } from 'zxing-wasm/full'
import { NON_DATA_QR_OPTIONS } from '@/constants'

/**
 * Generate a QR code from string or binary data and return as a data URL.
 * Drop-in replacement for QRCode.toDataURL() from the qrcode package.
 *
 * Note: zxing-wasm's sizeHint controls module size, not output size.
 * We generate with small modules then scale up for consistent density.
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

    const targetWidth = options?.width || 300

    // Use small sizeHint for dense QR, then scale up
    const result = await writeBarcode(binaryData, {
      format: 'QRCode',
      ecLevel: options?.errorCorrectionLevel || 'M',
      sizeHint: 4, // Small module size for density
      withQuietZones: true
    })

    if (result.error) {
      throw new Error(result.error)
    }

    const blob = result.image as Blob

    // Scale the image to target width
    return new Promise<string>((resolve, reject) => {
      const img = new Image()
      const objectUrl = URL.createObjectURL(blob)
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetWidth
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }
        // Use pixelated rendering for crisp QR scaling
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(img, 0, 0, targetWidth, targetWidth)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('Failed to load QR image'))
      }
      img.src = objectUrl
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