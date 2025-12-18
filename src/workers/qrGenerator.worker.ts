// QR Generation Worker
// Offloads expensive writeBarcode calls from main thread

import { writeBarcode, prepareZXingModule } from 'zxing-wasm/full'

// Configure zxing-wasm to use local WASM file (cached by service worker for offline support)
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => {
      if (path.endsWith('.wasm')) {
        return `/${path}`
      }
      return prefix + path
    },
  },
  fireImmediately: true,
})

// Listen for messages from main thread
self.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryString, binaryBuffer, options } = e.data

  if (type === 'generate') {
    try {
      let binaryData: Uint8Array

      if (binaryBuffer instanceof ArrayBuffer) {
        binaryData = new Uint8Array(binaryBuffer)
      } else if (typeof binaryString === 'string') {
        binaryData = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          binaryData[i] = binaryString.charCodeAt(i) & 0xFF
        }
      } else {
        throw new Error('Missing QR payload')
      }

      const result = await writeBarcode(binaryData, {
        format: 'QRCode',
        ecLevel: (options.errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H') || 'M',
        sizeHint: options.width || 400,
        withQuietZones: true
      })

      if (result.error) {
        throw new Error(result.error)
      }

      const blob = result.image as Blob
      const buffer = await blob.arrayBuffer()

      self.postMessage(
        { type: 'success', id, buffer, mimeType: blob.type || 'image/png' },
        [buffer]
      )
    } catch (error) {
      self.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}
