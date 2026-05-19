import { readQrCodesFromImageData, type RxingReaderOptions } from '@/utils/rxingWasm'

interface ScanMessage {
  type: 'scan'
  imageData: ImageData
  options?: RxingReaderOptions
}

interface ScanResult {
  type: 'result'
  data: Uint8Array[]
  error?: string
}

interface UnexpectedMessageResponse {
  type: 'error'
  error: string
  unexpectedType: string
  originalMessage: unknown
}

function isScanMessage(data: unknown): data is ScanMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'scan'
}

self.onmessage = async (e: MessageEvent<unknown>) => {
  if (isScanMessage(e.data)) {
    try {
      const { imageData, options } = e.data

      const readerOptions: RxingReaderOptions = {
        // Defaults tuned for general-purpose QR scanning: skip the heavier
        // `tryHarder` + `tryInvert` passes, adaptive binarizer for noisy
        // camera output. Rotation is handled natively by rxing's
        // finder-pattern canonical reordering, so no rotation-retry flag
        // is needed. Single-symbol output is enforced at the wasm boundary
        // in `readQrCodesFromRgba`.
        tryHarder: false,
        tryInvert: false,
        useHybridBinarizer: true,
        ...options,
      }

      const data = await readQrCodesFromImageData(imageData, readerOptions)

      const message: ScanResult = { type: 'result', data }
      self.postMessage(message)
    } catch (error) {
      const message: ScanResult = {
        type: 'result',
        data: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      self.postMessage(message)
    }
  } else {
    const unexpectedType = typeof e.data === 'object' && e.data !== null && 'type' in e.data
      ? String((e.data as Record<string, unknown>).type)
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
