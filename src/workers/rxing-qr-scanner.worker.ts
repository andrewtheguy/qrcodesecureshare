import { decodeQrFromImageData, type RxingReaderOptions } from '@/utils/rxingWasm'

interface ScanMessage {
  type: 'scan'
  imageData: ImageData
  options?: RxingReaderOptions
}

interface ScanResult {
  type: 'result'
  data: Uint8Array[] | null
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
      const { imageData, options } = e.data

      const readerOptions: RxingReaderOptions = {
        // Defaults tuned for fountain QR receivers: fast, no extra passes,
        // adaptive binarizer. Callers may override any of these.
        tryHarder: false,
        tryInvert: false,
        useHybridBinarizer: true,
        ...options,
      }

      const result = await decodeQrFromImageData(imageData, readerOptions)

      const data: Uint8Array[] | null = result ? [result] : null

      const message: ScanResult = { type: 'result', data }
      self.postMessage(message)
    } catch (error) {
      const message: ScanResult = {
        type: 'result',
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      self.postMessage(message)
    }
  } else {
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
