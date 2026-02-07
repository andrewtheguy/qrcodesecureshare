import { NON_DATA_QR_OPTIONS } from '@/constants'
import { generateFastQrPngBytes } from '@/utils/fastQrWasm'

function pngBytesToDataURL(pngBytes: Uint8Array): Promise<string> {
  const blob = new Blob([pngBytes], { type: 'image/png' })

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(reader.result as string)
    }
    reader.onerror = () => {
      reject(new Error('Failed to convert PNG bytes to data URL'))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * Generate a QR code from text string and return as a data URL.
 */
export async function generateQRTextDataURL(
  payload: string,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  try {
    const utf8Bytes = new TextEncoder().encode(payload)

    const pngBytes = await generateFastQrPngBytes(utf8Bytes, {
      width: options?.width || 300,
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      forceByteMode: false,
    })

    return await pngBytesToDataURL(pngBytes)
  } catch (err) {
    console.error('Failed to generate QR text data URL:', err)
    throw err
  }
}

// Shared main-thread function for non-data QR generation
export const generateNonDataQR = async (
  payload: object,
  opts?: {
    width?: number
    margin?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> => {
  try {
    const jsonString = JSON.stringify(payload)
    const jsonBytes = new TextEncoder().encode(jsonString)

    const options = opts || NON_DATA_QR_OPTIONS

    const pngBytes = await generateFastQrPngBytes(jsonBytes, {
      width: options.width || 400,
      margin: options.margin ?? 2,
      errorCorrectionLevel: options.errorCorrectionLevel || 'M',
      forceByteMode: false,
    })

    return await pngBytesToDataURL(pngBytes)
  } catch (err) {
    console.error('Failed to generate non-data QR:', err)
    throw err
  }
}
