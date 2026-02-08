/// <reference lib="webworker" />

import { FountainDecoder } from '../utils/fountainCodeWasm'
import { computeChecksum } from '../utils/checksum'
import { parseTextFountainFrame, type TextFountainFrame } from '../utils/textFountainProtocol'

interface DecoderSessionConfig {
  version: number
  sessionId: number
  textByteLength: number
  blockSize: number
  totalSourceBlocks: number
  finalCrc32: string
}

interface ProcessFrameMessage {
  type: 'processFrame'
  frame: Uint8Array | ArrayBuffer
}

interface ResetMessage {
  type: 'reset'
}

type WorkerRequest = ProcessFrameMessage | ResetMessage

let decoder: FountainDecoder | null = null
let sessionConfig: DecoderSessionConfig | null = null
let receivedChunkCount = 0
const receivedChunkKeys = new Set<string>()
let processingQueue: Promise<void> = Promise.resolve()

const postError = (error: string): void => {
  self.postMessage({ type: 'error', error })
}

const resetState = (): void => {
  decoder = null
  sessionConfig = null
  receivedChunkCount = 0
  receivedChunkKeys.clear()
}

const toUint8Array = (frame: Uint8Array | ArrayBuffer): Uint8Array =>
  frame instanceof Uint8Array ? frame : new Uint8Array(frame)

const createChunkKey = (seed: number, degree: number, indices: number[]): string => {
  const first = indices.length > 0 ? indices[0] : Number.MAX_SAFE_INTEGER
  const last = indices.length > 0 ? indices[indices.length - 1] : Number.MAX_SAFE_INTEGER
  return `${seed}:${degree}:${first}:${last}`
}

const buildSessionConfig = (frame: TextFountainFrame): DecoderSessionConfig => ({
  version: frame.version,
  sessionId: frame.sessionId,
  textByteLength: frame.textByteLength,
  blockSize: frame.blockSize,
  totalSourceBlocks: frame.totalSourceBlocks,
  finalCrc32: frame.finalCrc32,
})

const matchesSessionConfig = (config: DecoderSessionConfig, frame: TextFountainFrame): boolean =>
  config.version === frame.version &&
  config.sessionId === frame.sessionId &&
  config.textByteLength === frame.textByteLength &&
  config.blockSize === frame.blockSize &&
  config.totalSourceBlocks === frame.totalSourceBlocks &&
  config.finalCrc32 === frame.finalCrc32

const emitProgress = (): void => {
  if (!decoder || !sessionConfig) return

  const decodedBlockCount = decoder.wasm.getDecodedBlockCount()
  const totalSourceBlocks = sessionConfig.totalSourceBlocks
  const progress = totalSourceBlocks > 0 ? decodedBlockCount / totalSourceBlocks : 0

  self.postMessage({
    type: 'progress',
    decodedBlockCount,
    totalSourceBlocks,
    receivedChunkCount,
    progress,
  })
}

const initializeDecoder = async (frame: TextFountainFrame): Promise<void> => {
  const config = buildSessionConfig(frame)

  decoder = await FountainDecoder.create(
    {
      name: 'text-fountain.txt',
      size: config.textByteLength,
      fileType: 'text/plain',
      timestamp: Date.now(),
      totalSourceBlocks: config.totalSourceBlocks,
      blockSize: config.blockSize,
    },
    false,
    0
  )

  decoder.wasm.setSessionId(config.sessionId)
  decoder.wasm.setFinalChecksum(config.finalCrc32)
  sessionConfig = config
  receivedChunkCount = 0
  receivedChunkKeys.clear()

  self.postMessage({
    type: 'initialized',
    sessionId: config.sessionId,
    textByteLength: config.textByteLength,
    totalSourceBlocks: config.totalSourceBlocks,
  })
}

const maybeEmitComplete = async (): Promise<void> => {
  if (!decoder || !sessionConfig) return
  if (!decoder.isComplete()) return

  const decodedData = decoder.getDecodedData()
  if (!decodedData) {
    postError('Decoding completed but data is missing')
    return
  }

  const exactBytes =
    decodedData.length === sessionConfig.textByteLength
      ? decodedData
      : decodedData.slice(0, sessionConfig.textByteLength)

  const calculatedChecksum = await computeChecksum(exactBytes, 'crc32')
  if (calculatedChecksum !== sessionConfig.finalCrc32) {
    postError(
      `Final checksum mismatch: expected ${sessionConfig.finalCrc32}, got ${calculatedChecksum}`
    )
    return
  }

  const text = new TextDecoder().decode(exactBytes)
  self.postMessage({
    type: 'complete',
    text,
    checksum: calculatedChecksum,
    byteLength: exactBytes.length,
  })
}

const processFrame = async (frameInput: Uint8Array | ArrayBuffer): Promise<void> => {
  const frameBytes = toUint8Array(frameInput)

  let frame: TextFountainFrame
  try {
    frame = parseTextFountainFrame(frameBytes)
  } catch {
    // Ignore frames from other protocols or malformed scans.
    return
  }

  // Validate per-frame checksum. Bad frames are ignored, not fatal.
  const checksumPayload = frameBytes.slice(0, frameBytes.length - 4)
  const calculatedFrameCrc = await computeChecksum(checksumPayload, 'crc32')
  if (frame.frameCrc32 !== calculatedFrameCrc) {
    return
  }

  if (!decoder || !sessionConfig) {
    await initializeDecoder(frame)
  } else {
    // Ignore frames from other sessions silently.
    if (frame.sessionId !== sessionConfig.sessionId) {
      return
    }

    if (!matchesSessionConfig(sessionConfig, frame)) {
      postError('Frame metadata mismatch for active text fountain session')
      return
    }
  }

  if (!decoder) {
    postError('Decoder failed to initialize')
    return
  }

  const chunkKey = createChunkKey(frame.seed, frame.degree, frame.indices)
  if (receivedChunkKeys.has(chunkKey)) {
    emitProgress()
    return
  }

  receivedChunkKeys.add(chunkKey)
  receivedChunkCount += 1

  decoder.addChunk({
    seed: frame.seed,
    degree: frame.degree,
    indices: frame.indices,
    data: frame.chunkData,
  })

  emitProgress()
  await maybeEmitComplete()
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data

  if (message.type === 'reset') {
    processingQueue = processingQueue
      .then(() => {
        resetState()
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        postError(errorMessage)
      })
    return
  }

  processingQueue = processingQueue
    .then(() => processFrame(message.frame))
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      postError(errorMessage)
    })
}
