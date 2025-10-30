import type { FountainFeedback } from '@/types/fountainFeedback'
import wasmInit from '@/wasm/fountain_wasm'

// Checksum utilities using Rust WASM for CRC32
// Default: CRC32 (fast, non-cryptographic). Optionally supports SHA-256 when stronger integrity needed.

export type ChecksumAlgorithm = 'crc32' | 'sha256'

// WASM initialization state
let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

/**
 * Ensures WASM module is initialized before use
 */
async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        await wasmInit()
        wasmInitialized = true
      } catch (err) {
        console.error('[WASM Init] Failed to initialize checksum WASM:', err)
        throw new Error('Failed to initialize WASM module for checksums')
      }
    })()
  }

  await wasmInitPromise
}

export async function computeChecksum(
  dataInput: Uint8Array | ArrayBuffer,
  algorithm: ChecksumAlgorithm = 'crc32'
): Promise<string> {
  const data = dataInput instanceof Uint8Array ? dataInput : new Uint8Array(dataInput)
  if (algorithm === 'crc32') {
    // Ensure WASM is initialized before calling crc32
    await ensureWasmInit()
    const { crc32 } = await import('@/wasm/fountain_wasm')
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
    { partChecksumMatch: feedback.partChecksumMatch.toString() }
  ]

  // Create canonical string representation
  const canonicalString = JSON.stringify(fields)

  // Convert to Uint8Array using TextEncoder
  const encoder = new TextEncoder()
  const data = encoder.encode(canonicalString)

  // Compute CRC32 checksum using Rust WASM
  await ensureWasmInit()
  const { crc32 } = await import('@/wasm/fountain_wasm')
  const checksum = crc32(data)

  // Format as user-friendly code: uppercase hex with hyphen
  const upperChecksum = checksum.toUpperCase()
  return upperChecksum.slice(0, 4) + '-' + upperChecksum.slice(4)
}
