import { NON_DATA_QR_OPTIONS, SVG_QR_DISPLAY_SIZE } from '@/constants'
import { generateFastQrSvgString } from '@/utils/fastQrWasm'

function svgStringToDataURL(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * Generate a QR code from text string and return as a data URL.
 */
export async function generateQRTextDataURL(
  payload: string,
  options?: {
    margin?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  try {
    const utf8Bytes = new TextEncoder().encode(payload)

    const svg = await generateFastQrSvgString(utf8Bytes, {
      margin: options?.margin ?? 1,
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      forceByteMode: false,
      svgWidth: SVG_QR_DISPLAY_SIZE,
      svgHeight: SVG_QR_DISPLAY_SIZE,
    })

    return svgStringToDataURL(svg)
  } catch (err) {
    console.error('Failed to generate QR text data URL:', err)
    throw err
  }
}

// Shared main-thread function for non-data QR generation
export const generateNonDataQR = async (
  payload: object,
  opts?: {
    margin?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> => {
  try {
    const jsonString = JSON.stringify(payload)
    const jsonBytes = new TextEncoder().encode(jsonString)

    const options = opts || NON_DATA_QR_OPTIONS

    const svg = await generateFastQrSvgString(jsonBytes, {
      margin: options.margin ?? 1,
      errorCorrectionLevel: options.errorCorrectionLevel || 'M',
      forceByteMode: false,
      svgWidth: SVG_QR_DISPLAY_SIZE,
      svgHeight: SVG_QR_DISPLAY_SIZE,
    })

    return svgStringToDataURL(svg)
  } catch (err) {
    console.error('Failed to generate non-data QR:', err)
    throw err
  }
}
