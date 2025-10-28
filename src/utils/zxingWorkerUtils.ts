import ZXingWorker from '@/workers/zxing-qr-scanner.worker?worker'

interface ScanResult {
  type: 'result'
  data: string[] | null
  error?: string
}

/**
 * Decode QR codes from an image file using web worker
 * @param file The image file to decode
 * @returns Promise<string[] | null> Array of decoded QR code data or null if no QR codes found
 */
export function decodeQRFromImage(file: File): Promise<string[] | null> {
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

          // Send to worker for decoding
          worker.postMessage({
            type: 'scan',
            imageData,
          })
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
 * @returns Promise<string[] | null> Array of decoded QR code data or null if no QR codes found
 */
export function decodeQRFromImageData(imageData: ImageData): Promise<string[] | null> {
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

    // Send to worker for decoding
    worker.postMessage({
      type: 'scan',
      imageData,
    })
  })
}
