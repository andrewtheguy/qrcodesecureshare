// QR Generation Worker
// Offloads binary QR PNG generation from main thread

import { generateFastQrPngBytes } from '@/utils/fastQrWasm'

interface WorkerRequest {
  type: 'generate'
  id: number
  binaryString?: string
  binaryBuffer?: ArrayBuffer
  options?: {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    width?: number
    margin?: number
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, id, binaryString, binaryBuffer, options } = e.data

  if (type !== 'generate') return

  try {
    let binaryData: Uint8Array

    if (binaryBuffer instanceof ArrayBuffer) {
      binaryData = new Uint8Array(binaryBuffer)
    } else if (typeof binaryString === 'string') {
      binaryData = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        binaryData[i] = binaryString.charCodeAt(i) & 0xff
      }
    } else {
      throw new Error('Missing QR payload')
    }

    const pngBytes = await generateFastQrPngBytes(binaryData, {
      width: options?.width || 400,
      margin: options?.margin ?? 4,
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      forceByteMode: true,
    })

    const transferableBytes =
      pngBytes.byteOffset === 0 && pngBytes.byteLength === pngBytes.buffer.byteLength
        ? pngBytes
        : pngBytes.slice()

    self.postMessage(
      {
        type: 'success',
        id,
        buffer: transferableBytes.buffer,
        mimeType: 'image/png',
      },
      [transferableBytes.buffer]
    )
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
