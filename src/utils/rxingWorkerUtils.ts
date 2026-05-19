import RxingWorker from '@/workers/rxing-qr-scanner.worker?worker'
import type { RxingReaderOptions } from '@/utils/rxingWasm'

interface ScanResult {
  type: 'result'
  data: Uint8Array[]
  error?: string
}

// Default maximized detection options for general QR code scanning
const MAXIMIZED_DETECTION_OPTIONS: RxingReaderOptions = {
  tryHarder: true,
  tryInvert: true,
  useHybridBinarizer: true,
}

/**
 * Decode QR codes from an image file using a web worker.
 */
export function decodeQRFromImage(
  file: File,
  readerOptions?: RxingReaderOptions
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const imageUrl = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height

        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }

        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

        const worker = new RxingWorker()

        worker.onmessage = (event: MessageEvent<ScanResult>) => {
          if (event.data.type === 'result') {
            worker.terminate()
            worker.onmessage = null

            if (event.data.error) {
              reject(new Error(event.data.error))
            } else {
              resolve(event.data.data)
            }
          } else {
            worker.terminate()
            worker.onmessage = null
            reject(new Error(`Unexpected message type from worker: ${event.data.type}`))
          }
        }

        worker.onerror = (err) => {
          worker.terminate()
          reject(err)
        }

        worker.postMessage(
          {
            type: 'scan',
            imageData,
            options: readerOptions || MAXIMIZED_DETECTION_OPTIONS,
          },
          [imageData.data.buffer]
        )
      } catch (err) {
        reject(err)
      } finally {
        URL.revokeObjectURL(imageUrl)
      }
    }

    img.onerror = () => {
      URL.revokeObjectURL(imageUrl)
      reject(new Error('Failed to load image'))
    }

    img.src = imageUrl
  })
}

/**
 * Decode QR codes from ImageData using a web worker.
 */
export function decodeQRFromImageData(
  imageData: ImageData,
  readerOptions?: RxingReaderOptions
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const worker = new RxingWorker()

    worker.onmessage = (event: MessageEvent<ScanResult>) => {
      if (event.data.type === 'result') {
        worker.terminate()
        worker.onmessage = null

        if (event.data.error) {
          reject(new Error(event.data.error))
        } else {
          resolve(event.data.data)
        }
      } else {
        worker.terminate()
        worker.onmessage = null
        reject(new Error(`Unexpected message type from worker: ${event.data.type}`))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      {
        type: 'scan',
        imageData,
        options: readerOptions || MAXIMIZED_DETECTION_OPTIONS,
      },
      [imageData.data.buffer]
    )
  })
}
