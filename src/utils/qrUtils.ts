import { writeBarcode } from 'zxing-wasm/full'
import { NON_DATA_QR_OPTIONS } from '@/constants'

/**
 * Scale an image blob to a target width and return as a PNG data URL.
 * Creates/revokes object URL, uses canvas for scaling, and handles errors.
 *
 * @param blob - The source image blob to scale
 * @param targetWidth - The desired output width (height uses image aspect ratio)
 * @param preservePixelation - When true, disables image smoothing for crisp pixel scaling (useful for QR codes)
 * @returns Promise resolving to a PNG data URL
 */
function scaleImageBlob(
  blob: Blob,
  targetWidth: number,
  preservePixelation = false
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(blob)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)

      // Calculate height based on aspect ratio
      const aspectRatio = img.naturalHeight / img.naturalWidth
      const targetHeight = Math.round(targetWidth * aspectRatio)

      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas 2D context'))
        return
      }

      if (preservePixelation) {
        ctx.imageSmoothingEnabled = false
      }

      ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
      resolve(canvas.toDataURL('image/png'))
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image from blob'))
    }

    img.src = objectUrl
  })
}

/**
 * Generate a QR code from binary data and return as a data URL.
 *
 * Note: zxing-wasm's sizeHint controls module size, not output size.
 * We generate with small modules then scale up for consistent density.
 */
export async function generateQRBinaryDataURL(
  payload: Uint8Array,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  try {
    const targetWidth = options?.width || 300

    // Use small sizeHint for dense QR, then scale up
    const result = await writeBarcode(payload, {
      format: 'QRCode',
      ecLevel: options?.errorCorrectionLevel || 'M',
      sizeHint: 4, // Small module size for density
      withQuietZones: true
    })

    if (result.error) {
      throw new Error(result.error)
    }

    if (!result.image || !(result.image instanceof Blob)) {
      throw new TypeError('Expected result.image to be a Blob, got: ' + typeof result.image)
    }

    // Scale QR image to target width with pixelation preserved for crisp modules
    return await scaleImageBlob(result.image, targetWidth, true)
  } catch (err) {
    console.error('Failed to generate QR binary data URL:', err)
    throw err
  }
}

/**
 * Generate a QR code from text string and return as a data URL.
 * Passes the string directly to writeBarcode for proper text mode encoding.
 *
 * Note: zxing-wasm's sizeHint controls module size, not output size.
 * We generate with small modules then scale up for consistent density.
 */
export async function generateQRTextDataURL(
  payload: string,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  try {
    const targetWidth = options?.width || 300

    // Pass string directly to writeBarcode for text mode (not as Uint8Array)
    const result = await writeBarcode(payload, {
      format: 'QRCode',
      ecLevel: options?.errorCorrectionLevel || 'M',
      sizeHint: 4, // Small module size for density
      withQuietZones: true
    })

    if (result.error) {
      throw new Error(result.error)
    }

    if (!result.image || !(result.image instanceof Blob)) {
      throw new TypeError('Expected result.image to be a Blob, got: ' + typeof result.image)
    }

    // Scale QR image to target width with pixelation preserved for crisp modules
    return await scaleImageBlob(result.image, targetWidth, true)
  } catch (err) {
    console.error('Failed to generate QR text data URL:', err)
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

    if (!result.image || !(result.image instanceof Blob)) {
      throw new TypeError('Expected result.image to be a Blob, got: ' + typeof result.image)
    }

    // Convert Blob to data URL
    const blob = result.image
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