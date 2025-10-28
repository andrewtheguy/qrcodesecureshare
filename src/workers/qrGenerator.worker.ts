// QR Generation Worker
// Offloads expensive writeBarcode calls from main thread

import { writeBarcode } from 'zxing-wasm/full'

// Listen for messages from main thread
self.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryString, options } = e.data

  if (type === 'generate') {
    try {
      // Convert binary string back to Uint8Array for zxing-wasm
      const binaryData = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        binaryData[i] = binaryString.charCodeAt(i) & 0xFF
      }

      // Generate QR code using zxing-wasm
      const result = await writeBarcode(binaryData, {
        format: 'QRCode',
        ecLevel: (options.errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H') || 'M',
        sizeHint: options.width || 400,
        withQuietZones: true
      })

      if (result.error) {
        throw new Error(result.error)
      }

      // Convert Blob to data URL
      const blob = result.image as Blob
      const reader = new FileReader()
      reader.onload = () => {
        const qrUrl = reader.result as string
        self.postMessage({ type: 'success', id, qrUrl })
      }
      reader.onerror = () => {
        self.postMessage({ type: 'error', id, error: 'Failed to convert blob to data URL' })
      }
      reader.readAsDataURL(blob)
    } catch (error) {
      self.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}