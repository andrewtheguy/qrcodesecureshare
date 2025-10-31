import type { FountainFeedback } from '@/types/fountainFeedback'
import { ensureWasmInit } from './fountainCodeWasm'

// Checksum utilities using Rust WASM for CRC32
// Default: CRC32 (fast, non-cryptographic). Optionally supports SHA-256 when stronger integrity needed.

export type ChecksumAlgorithm = 'crc32' | 'sha256'

export async function computeChecksum(
  dataInput: Uint8Array | ArrayBuffer,
  algorithm: ChecksumAlgorithm = 'crc32'
): Promise<string> {
  const data = dataInput instanceof Uint8Array ? dataInput : new Uint8Array(dataInput)
  if (algorithm === 'crc32') {
    // Ensure WASM is initialized before using it
    await ensureWasmInit()
    // Use Rust WASM function - import here after init to ensure binding is available
    const { crc32 } = await import('../../rust/fountain-wasm/pkg/fountain_wasm')
    return crc32(data)
  }
  // SHA-256 path using browser WebCrypto
  const copy = new Uint8Array(data) // fresh ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/**
 * Compute CRC32 checksum and return as raw bytes (4 bytes, big-endian)
 * For use in binary data formats where raw bytes are needed instead of hex strings
 */
export async function computeChecksumBytes(dataInput: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const data = dataInput instanceof Uint8Array ? dataInput : new Uint8Array(dataInput)
  // Ensure WASM is initialized before using it
  await ensureWasmInit()
  // Use Rust WASM function - import here after init to ensure binding is available
  const { crc32_bytes } = await import('../../rust/fountain-wasm/pkg/fountain_wasm')
  return crc32_bytes(data)
}

export function normalizeConfirmationCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase()
}

/**
 * Generates a confirmation code for feedback payloads.
 * The confirmation code validates all essential feedback fields for manual input mode.
 *
 * SYNC REQUIREMENT: Fields included in checksum MUST match exactly with:
 * 1. FountainQRFeedbackDisplay.tsx - feedback generation
 * 2. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation
 * 3. FountainQRManualFeedbackInput.tsx - validateInputs() and UI fields
 *
 * IMPORTANT: Only include REQUIRED fields. Do NOT include optional fields.
 * Optional fields will cause confirmation code mismatches between QR and manual input.
 */
export async function generateFeedbackConfirmationCode(feedback: FountainFeedback): Promise<string> {
  // DEBUG: Log the incoming feedback object
  //console.log('[generateFeedbackConfirmationCode] Input feedback:', JSON.stringify(feedback, null, 2));

  // Check for unexpected extra fields
  const knownFields = ['type', 'mode', 'sessionId', 'sequence', 'currentPart', 'totalParts', 'partChecksumMatch']

  const actualFields = Object.keys(feedback);
  const extraFields = actualFields.filter(f => !knownFields.includes(f));
  if (extraFields.length > 0) {
    console.warn('[generateFeedbackConfirmationCode] ⚠️  Extra fields detected (will be ignored):', extraFields);
    extraFields.forEach(f => {
      console.warn(`  - ${f}:`, (feedback as unknown as Record<string, unknown>)[f]);
    });
  }

  // Extract essential fields as array of JSON objects with single key-value pairs for easier debugging
  const fields: Array<Record<string, string>> = [
    { version: "3" }, // v3: Simplified to part-complete mode, removed progress/firstMissingBlock
    { type: feedback.type },
    { mode: feedback.mode },
    { sessionId: feedback.sessionId.toString() },
    { sequence: feedback.sequence.toString() },
    { currentPart: feedback.currentPart.toString() },
    { totalParts: feedback.totalParts.toString() },
    { partChecksumMatch: (feedback.partChecksumMatch ?? feedback.isValid ?? false).toString() }
  ]

  // Create canonical string representation
  const canonicalString = JSON.stringify(fields)

  // Convert to Uint8Array using TextEncoder
  const encoder = new TextEncoder()
  const data = encoder.encode(canonicalString)

  // Compute CRC32 checksum using Rust WASM (centralized initialization and import)
  const checksum = await computeChecksum(data, 'crc32')

  // Format as user-friendly code: uppercase hex with hyphen
  const upperChecksum = checksum.toUpperCase()
  return upperChecksum.slice(0, 4) + '-' + upperChecksum.slice(4)
}
