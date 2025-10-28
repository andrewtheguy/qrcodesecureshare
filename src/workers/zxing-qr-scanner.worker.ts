import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

interface ScanMessage {
  type: 'scan'
  imageData: ImageData
  options?: ReaderOptions
}

interface ScanResult {
  type: 'result'
  data: string[] | null
  error?: string
}

self.onmessage = async (e: MessageEvent<ScanMessage>) => {
  if (e.data.type === 'scan') {
    try {
      const { imageData, options } = e.data

      const readerOptions: ReaderOptions = {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
        ...options,
      }

      const results = await readBarcodes(imageData, readerOptions)

      const detectedTexts = results.length > 0 ? results.map((r) => r.text) : null

      const result: ScanResult = {
        type: 'result',
        data: detectedTexts,
      }
      self.postMessage(result)
    } catch (error) {
      const result: ScanResult = {
        type: 'result',
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      self.postMessage(result)
    }
  }
}

export {}
