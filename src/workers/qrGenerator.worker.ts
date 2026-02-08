// QR Generation Worker
// Offloads binary QR matrix generation from main thread.

import { generateFastQrModuleMatrix } from '@/utils/fastQrWasm'

interface WorkerRequest {
  type: 'generate'
  id: number
  binaryString?: string
  binaryBuffer?: ArrayBuffer
  options?: {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, id, binaryString, binaryBuffer, options } = e.data

  if (type !== 'generate') {
    self.postMessage({
      type: 'error',
      id,
      error: `Unknown message type: ${String(type)}`,
    })
    return
  }

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

    const matrix = await generateFastQrModuleMatrix(binaryData, {
      margin: options?.margin ?? 1,
      errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
      forceByteMode: true,
    })

    const transferableModules =
      matrix.modules.byteOffset === 0 &&
      matrix.modules.byteLength === matrix.modules.buffer.byteLength
        ? matrix.modules
        : matrix.modules.slice()

    self.postMessage(
      {
        type: 'success',
        id,
        moduleBuffer: transferableModules.buffer,
        moduleCount: matrix.moduleCount,
      },
      [transferableModules.buffer]
    )
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
