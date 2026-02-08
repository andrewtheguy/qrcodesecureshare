import {
  TEXT_FOUNTAIN_MAGIC,
  TEXT_FOUNTAIN_VERSION,
} from '@/constants'
import { computeChecksum } from '@/utils/checksum'

const FIXED_HEADER_SIZE = 23
const FRAME_CRC_SIZE = 4
const MIN_CHUNK_DATA_SIZE = 1
const MIN_FRAME_SIZE = FIXED_HEADER_SIZE + 2 + MIN_CHUNK_DATA_SIZE + FRAME_CRC_SIZE

export interface TextFountainFrame {
  version: number
  sessionId: number
  textByteLength: number
  blockSize: number
  totalSourceBlocks: number
  finalCrc32: string
  seed: number
  degree: number
  indices: number[]
  chunkData: Uint8Array
  /**
   * CRC32 extracted from the trailing 4 bytes of the frame payload.
   *
   * Note: parseTextFountainFrame() does not validate this checksum against frame bytes.
   * Validation is performed downstream in the decoder worker
   * (src/workers/textFountainDecoder.worker.ts, processFrame()).
   */
  frameCrc32?: string
}

const readU16 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 8) | bytes[offset + 1]

const readU32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0

const writeU16 = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = (value >> 8) & 0xff
  bytes[offset + 1] = value & 0xff
}

const writeU32 = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const normalizeCrc32Hex = (value: string, fieldName: string): string => {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName}: expected 8 hex characters`)
  }
  return normalized
}

const crcHexToBytes = (hex: string): Uint8Array => {
  const normalized = normalizeCrc32Hex(hex, 'CRC32')
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    out[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function isTextFountainFrame(payload: Uint8Array): boolean {
  return payload.length >= 2 && payload[0] === TEXT_FOUNTAIN_MAGIC[0] && payload[1] === TEXT_FOUNTAIN_MAGIC[1]
}

export async function serializeTextFountainFrame(frame: TextFountainFrame): Promise<Uint8Array> {
  const sessionId = frame.sessionId >>> 0
  const textByteLength = frame.textByteLength >>> 0
  const blockSize = frame.blockSize >>> 0
  const totalSourceBlocks = frame.totalSourceBlocks >>> 0
  const seed = frame.seed >>> 0
  const indices = frame.indices
  const chunkData = frame.chunkData
  const degree = frame.degree >>> 0

  if (frame.version !== TEXT_FOUNTAIN_VERSION) {
    throw new Error(`Unsupported text fountain version: ${frame.version}`)
  }
  if (sessionId > 0xffff) {
    throw new Error('sessionId must fit in uint16')
  }
  if (blockSize === 0 || blockSize > 0xffff) {
    throw new Error('blockSize must be in range 1..65535')
  }
  if (totalSourceBlocks === 0 || totalSourceBlocks > 0xffff) {
    throw new Error('totalSourceBlocks must be in range 1..65535')
  }
  if (textByteLength === 0) {
    throw new Error('textByteLength must be > 0')
  }
  if (degree > 0xff) {
    throw new Error('degree must fit in uint8')
  }
  if (indices.length === 0 || indices.length > 0xff) {
    throw new Error('indices length must be in range 1..255')
  }
  if (degree !== indices.length) {
    throw new Error('degree must match indices length')
  }
  for (const index of indices) {
    if (index < 0 || index > 0xffff) {
      throw new Error('chunk index must fit in uint16')
    }
  }
  if (chunkData.length === 0) {
    throw new Error('chunkData must not be empty')
  }

  const finalCrc32 = normalizeCrc32Hex(frame.finalCrc32, 'finalCrc32')
  const finalCrc32Bytes = crcHexToBytes(finalCrc32)

  const frameLength = FIXED_HEADER_SIZE + (indices.length * 2) + chunkData.length + FRAME_CRC_SIZE
  const bytes = new Uint8Array(frameLength)

  let offset = 0
  bytes[offset++] = TEXT_FOUNTAIN_MAGIC[0]
  bytes[offset++] = TEXT_FOUNTAIN_MAGIC[1]
  bytes[offset++] = frame.version
  writeU16(bytes, offset, sessionId)
  offset += 2
  writeU32(bytes, offset, textByteLength)
  offset += 4
  writeU16(bytes, offset, blockSize)
  offset += 2
  writeU16(bytes, offset, totalSourceBlocks)
  offset += 2
  bytes.set(finalCrc32Bytes, offset)
  offset += 4
  writeU32(bytes, offset, seed)
  offset += 4
  bytes[offset++] = degree
  bytes[offset++] = indices.length

  for (const index of indices) {
    writeU16(bytes, offset, index)
    offset += 2
  }

  bytes.set(chunkData, offset)
  offset += chunkData.length

  const frameCrc32 = await computeChecksum(bytes.slice(0, offset), 'crc32')
  const frameCrc32Bytes = crcHexToBytes(frameCrc32)
  bytes.set(frameCrc32Bytes, offset)

  return bytes
}

/**
 * Parse a text fountain frame into structured fields.
 *
 * This function validates frame structure and required field constraints,
 * then extracts the trailing frame CRC32 value as `frameCrc32`.
 *
 * Important:
 * - It does NOT verify `frameCrc32` against the frame payload.
 * - Integrity verification is performed downstream by callers.
 * - In the current flow, validation happens in
 *   `src/workers/textFountainDecoder.worker.ts` inside `processFrame()`.
 */
export function parseTextFountainFrame(bytes: Uint8Array): TextFountainFrame {
  if (bytes.length < MIN_FRAME_SIZE) {
    throw new Error('Text fountain frame is too short')
  }
  if (!isTextFountainFrame(bytes)) {
    throw new Error('Invalid text fountain frame magic')
  }

  let offset = 2
  const version = bytes[offset++]
  if (version !== TEXT_FOUNTAIN_VERSION) {
    throw new Error(`Unsupported text fountain version: ${version}`)
  }

  const sessionId = readU16(bytes, offset)
  offset += 2
  const textByteLength = readU32(bytes, offset)
  offset += 4
  const blockSize = readU16(bytes, offset)
  offset += 2
  const totalSourceBlocks = readU16(bytes, offset)
  offset += 2
  const finalCrc32 = bytesToHex(bytes.slice(offset, offset + 4))
  offset += 4
  const seed = readU32(bytes, offset)
  offset += 4
  const degree = bytes[offset++]
  const numIndices = bytes[offset++]

  if (textByteLength === 0) {
    throw new Error('textByteLength must be > 0')
  }
  if (blockSize === 0) {
    throw new Error('blockSize must be > 0')
  }
  if (totalSourceBlocks === 0) {
    throw new Error('totalSourceBlocks must be > 0')
  }

  if (numIndices === 0) {
    throw new Error('numIndices must be > 0')
  }
  if (degree !== numIndices) {
    throw new Error(`degree mismatch: ${degree} != ${numIndices}`)
  }

  const minSizeForDeclaredIndices = FIXED_HEADER_SIZE + (numIndices * 2) + MIN_CHUNK_DATA_SIZE + FRAME_CRC_SIZE
  if (bytes.length < minSizeForDeclaredIndices) {
    throw new Error('Frame too short for declared indices')
  }

  const indices: number[] = []
  for (let i = 0; i < numIndices; i++) {
    indices.push(readU16(bytes, offset))
    offset += 2
  }

  const checksumStart = bytes.length - FRAME_CRC_SIZE
  if (checksumStart <= offset) {
    throw new Error('Missing chunk data')
  }

  const chunkData = bytes.slice(offset, checksumStart)
  if (chunkData.length < MIN_CHUNK_DATA_SIZE) {
    throw new Error('Chunk data must not be empty')
  }

  const frameCrc32 = bytesToHex(bytes.slice(checksumStart))

  return {
    version,
    sessionId,
    textByteLength,
    blockSize,
    totalSourceBlocks,
    finalCrc32,
    seed,
    degree,
    indices,
    chunkData,
    frameCrc32,
  }
}
