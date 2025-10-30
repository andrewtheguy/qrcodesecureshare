import init, {
  WasmFountainEncoder,
  WasmFountainDecoder,
} from '../../rust/fountain-wasm/pkg/fountain_wasm'

interface FountainChunk {
  seed: number
  degree: number
  indices: number[]
  data: Uint8Array
}

interface FountainMetadata {
  name: string
  size: number
  fileType: string
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
}

interface InitEncoderMessage {
  type: 'init_encoder'
  data: Uint8Array
  name: string
  fileType: string
  timestamp: number
  blockSize?: number
}

interface GenerateChunkMessage {
  type: 'generate_chunk'
}

interface GetMetadataMessage {
  type: 'get_metadata'
}

interface InitDecoderMessage {
  type: 'init_decoder'
  metadata: FountainMetadata
}

interface AddChunkMessage {
  type: 'add_chunk'
  chunk: FountainChunk
}

interface GetProgressMessage {
  type: 'get_progress'
}

interface GetDecodedDataMessage {
  type: 'get_decoded_data'
}

type WorkerMessage =
  | InitEncoderMessage
  | GenerateChunkMessage
  | GetMetadataMessage
  | InitDecoderMessage
  | AddChunkMessage
  | GetProgressMessage
  | GetDecodedDataMessage

interface SuccessResult {
  type: 'result'
  data: unknown
  error?: never
}

interface ErrorResult {
  type: 'result'
  data?: never
  error: string
}

interface UnexpectedMessageResponse {
  type: 'error'
  error: string
  unexpectedType: string
  originalMessage: unknown
}

// Initialize WASM module when worker starts
let wasmInitialized = false
let initPromise: Promise<void> | null = null
let encoder: WasmFountainEncoder | null = null
let decoder: WasmFountainDecoder | null = null

async function ensureWasmInitialized() {
  if (wasmInitialized) return

  if (initPromise) {
    await initPromise
    return
  }

  initPromise = init().then(() => {
    wasmInitialized = true
  })

  await initPromise
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  try {
    // Ensure WASM is initialized before processing any messages
    await ensureWasmInitialized()

    const message = e.data

    switch (message.type) {
      case 'init_encoder': {
        encoder = new WasmFountainEncoder(
          message.data,
          message.name,
          message.fileType,
          message.timestamp,
          message.blockSize,
          undefined,
          undefined
        )
        const result: SuccessResult = {
          type: 'result',
          data: { success: true },
        }
        self.postMessage(result)
        break
      }

      case 'generate_chunk': {
        if (!encoder) {
          throw new Error('Encoder not initialized')
        }
        const chunk = encoder.generateChunk()
        const result: SuccessResult = {
          type: 'result',
          data: chunk,
        }
        self.postMessage(result)
        break
      }

      case 'get_metadata': {
        if (!encoder) {
          throw new Error('Encoder not initialized')
        }
        const metadata = encoder.getMetadata()
        const result: SuccessResult = {
          type: 'result',
          data: metadata,
        }
        self.postMessage(result)
        break
      }

      case 'init_decoder': {
        decoder = new WasmFountainDecoder(message.metadata)
        const result: SuccessResult = {
          type: 'result',
          data: { success: true },
        }
        self.postMessage(result)
        break
      }

      case 'add_chunk': {
        if (!decoder) {
          throw new Error('Decoder not initialized')
        }
        const decoded = decoder.addChunk(message.chunk)
        const result: SuccessResult = {
          type: 'result',
          data: {
            decoded,
            isComplete: decoder.isComplete(),
            progress: decoder.getProgress(),
            decodedBlockCount: decoder.getDecodedBlockCount(),
            receivedChunkCount: decoder.getReceivedChunkCount(),
          },
        }
        self.postMessage(result)
        break
      }

      case 'get_progress': {
        if (!decoder) {
          throw new Error('Decoder not initialized')
        }
        const result: SuccessResult = {
          type: 'result',
          data: {
            progress: decoder.getProgress(),
            isComplete: decoder.isComplete(),
            decodedBlockCount: decoder.getDecodedBlockCount(),
            receivedChunkCount: decoder.getReceivedChunkCount(),
          },
        }
        self.postMessage(result)
        break
      }

      case 'get_decoded_data': {
        if (!decoder) {
          throw new Error('Decoder not initialized')
        }
        const data = decoder.getDecodedData()
        const result: SuccessResult = {
          type: 'result',
          data: data,
        }
        self.postMessage(result)
        break
      }

      default: {
        // Handle unexpected message types for debugging
        const unexpectedType =
          typeof message === 'object' && message !== null && 'type' in message
            ? String((message as Record<string, unknown>).type)
            : 'unknown'

        const errorMessage = `Unexpected message type received: ${unexpectedType}`
        console.warn(errorMessage, message)

        const errorResponse: UnexpectedMessageResponse = {
          type: 'error',
          error: errorMessage,
          unexpectedType,
          originalMessage: message,
        }
        self.postMessage(errorResponse)
      }
    }
  } catch (error) {
    const result: ErrorResult = {
      type: 'result',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    self.postMessage(result)
  }
}

export {}
