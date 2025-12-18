import ZXingWorker from '@/workers/zxing-qr-scanner.worker?worker'
import type { ReaderOptions } from 'zxing-wasm/reader'

interface ScanResult {
  type: 'result'
  data: (string | Uint8Array)[] | null
  error?: string
}

// Default maximized detection options for general QR code scanning
const MAXIMIZED_DETECTION_OPTIONS: Partial<ReaderOptions> = {
  formats: ['QRCode'],
  tryHarder: true, // Spend more time finding barcodes
  tryRotate: true, // Check rotated versions
  tryInvert: true, // Check inverted versions (important for color/contrast variations)
  tryDownscale: true, // Try downscaled versions for distant QR codes
  tryDenoise: true, // Experimental: try denoising for noisy images
  binarizer: 'LocalAverage', // Use adaptive thresholding for color variations
  maxNumberOfSymbols: 1, // Only return first QR code found
}

/**
 * Decode QR codes from an image file using web worker
 * @param file The image file to decode
 * @param readerOptions Optional custom reader options for detection tuning
 * @returns Promise<string[] | null> Array of decoded QR code data or null if no QR codes found
 */
export function decodeQRFromImage(
  file: File,
  readerOptions?: Partial<ReaderOptions>,
  binary = false
): Promise<(string | Uint8Array)[] | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = async (e) => {
      try {
        const imageUrl = e.target?.result as string
        const img = new Image()

        img.onload = () => {
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

          // Create worker for this decode operation
          const worker = new ZXingWorker()

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

          // Send to worker for decoding using transferable object for performance
          // The ArrayBuffer will be transferred (not copied) to the worker
          worker.postMessage(
            {
              type: 'scan',
              imageData,
              binary,
              options: readerOptions || MAXIMIZED_DETECTION_OPTIONS,
            },
            [imageData.data.buffer]
          )
        }

        img.onerror = () => {
          reject(new Error('Failed to load image'))
        }

        img.src = imageUrl
      } catch (err) {
        reject(err)
      }
    }

    reader.onerror = () => {
      reject(new Error('Failed to read file'))
    }

    reader.readAsDataURL(file)
  })
}

/**
 * Decode QR codes from ImageData using web worker
 * @param imageData The ImageData to decode
 * @param readerOptions Optional custom reader options for detection tuning
 * @returns Promise<string[] | null> Array of decoded QR code data or null if no QR codes found
 */
export function decodeQRFromImageData(
  imageData: ImageData,
  readerOptions?: Partial<ReaderOptions>,
  binary = false
): Promise<(string | Uint8Array)[] | null> {
  return new Promise((resolve, reject) => {
    const worker = new ZXingWorker()

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

    // Send to worker for decoding using transferable object for performance
    // The ArrayBuffer will be transferred (not copied) to the worker
    worker.postMessage(
      {
        type: 'scan',
        imageData,
        binary,
        options: readerOptions || MAXIMIZED_DETECTION_OPTIONS,
      },
      [imageData.data.buffer]
    )
  })
}
