import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

interface ScanMessage {
  type: 'scan'
  imageData: ImageData
  options?: ReaderOptions
  binary?: boolean // If true, return raw bytes; if false, return text
}

interface ScanResult {
  type: 'result'
  data: (string | Uint8Array)[] | null
  error?: string
}

interface UnexpectedMessageResponse {
  type: 'error'
  error: string
  unexpectedType: string
  originalMessage: unknown
}

self.onmessage = async (e: MessageEvent<ScanMessage>) => {
  if (e.data.type === 'scan') {
    try {
      const { imageData, options, binary = false } = e.data

      const readerOptions: ReaderOptions = {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
        ...options,
      }

      const results = await readBarcodes(imageData, readerOptions)

      const detectedData = results.length > 0
        ? results.map((r) => {
            // If binary mode is enabled, return raw bytes; otherwise return text
            if (binary) {
              return r.bytes
            } else {
              return r.text
            }
          })
        : null

      const result: ScanResult = {
        type: 'result',
        data: detectedData,
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
  } else {
    // Handle unexpected message types for debugging
    const unexpectedType = typeof e.data === 'object' && e.data !== null && 'type' in e.data
      ? String((e.data as unknown as Record<string, unknown>).type)
      : 'unknown'

    const errorMessage = `Unexpected message type received: ${unexpectedType}`
    console.warn(errorMessage, e.data)

    const errorResponse: UnexpectedMessageResponse = {
      type: 'error',
      error: errorMessage,
      unexpectedType,
      originalMessage: e.data,
    }
    self.postMessage(errorResponse)
  }
}

export {}
