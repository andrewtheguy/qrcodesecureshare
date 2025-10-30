import init, { hello_world, greet } from '../../rust/hello-wasm/pkg/hello_wasm.js'

interface HelloMessage {
  type: 'hello'
}

interface GreetMessage {
  type: 'greet'
  name: string
}

type WorkerMessage = HelloMessage | GreetMessage

interface SuccessResult {
  type: 'result'
  message: string
  error?: never
}

interface ErrorResult {
  type: 'result'
  message?: never
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

    if (e.data.type === 'hello') {
      const message = hello_world()
      const result: SuccessResult = {
        type: 'result',
        message,
      }
      self.postMessage(result)
    } else if (e.data.type === 'greet') {
      const message = greet(e.data.name)
      const result: SuccessResult = {
        type: 'result',
        message,
      }
      self.postMessage(result)
    } else {
      // Handle unexpected message types for debugging
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
  } catch (error) {
    const result: ErrorResult = {
      type: 'result',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    self.postMessage(result)
  }
}

export {}
