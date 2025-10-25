import type { FountainFeedback } from '@/types/fountainFeedback'
import { crc32 as hashCrc32 } from 'hash-wasm'

// Checksum utilities using hash-wasm for CRC32
// Default: CRC32 (fast, non-cryptographic). Optionally supports SHA-256 when stronger integrity needed.

export type ChecksumAlgorithm = 'crc32' | 'sha256'

export async function computeChecksum(
  dataInput: Uint8Array | ArrayBuffer,
  algorithm: ChecksumAlgorithm = 'crc32'
): Promise<string> {
  const data = dataInput instanceof Uint8Array ? dataInput : new Uint8Array(dataInput)
  if (algorithm === 'crc32') {
    return await hashCrc32(data)
  }
  // SHA-256 path using browser WebCrypto
  const copy = new Uint8Array(data) // fresh ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

export function normalizeConfirmationCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase()
}

/**
 * Generates a confirmation code for feedback payloads.
 * The confirmation code includes the progress field in its calculation to ensure
 * all feedback fields are validated when using manual input mode.
 */
export async function generateFeedbackConfirmationCode(feedback: FountainFeedback): Promise<string> {
  // Extract essential fields as array of JSON objects with single key-value pairs for easier debugging
  const fields: Array<Record<string, string>> = [
    { version: "1" },
    { type: feedback.type },
    { mode: feedback.mode },
    { sessionId: feedback.sessionId.toString() },
    { sequence: feedback.sequence.toString() },
    { firstMissingBlock: feedback.firstMissingBlock.toString() },
    { progress: feedback.progress.toString() },
    { decodedInWindow: feedback.decodedInWindow.toString() },
  ]

  // Add mode-specific fields
  if (feedback.mode === 'targeted') {
    const sortedMissingBlocks = [...feedback.missingBlocks].sort((a, b) => a - b)
    fields.push({ missingBlocks: sortedMissingBlocks.join(',') })
  }

  // Create canonical string representation
  const canonicalString = JSON.stringify(fields)

  // Convert to Uint8Array using TextEncoder
  const encoder = new TextEncoder()
  const data = encoder.encode(canonicalString)

  // Compute CRC32 checksum using hash-wasm
  const checksum = await hashCrc32(data)

  // Format as user-friendly code: uppercase hex with hyphen
  const upperChecksum = checksum.toUpperCase()
  return upperChecksum.slice(0, 4) + '-' + upperChecksum.slice(4)
}
