import type { FountainFeedback } from '@/types/fountainFeedback'
import { ensureWasmInit } from './fountainCodeWasm'

// Checksum utilities using Rust WASM for CRC32
// Default: CRC32 (fast, non-cryptographic). Optionally supports SHA-256 when stronger integrity needed.

export type ChecksumAlgorithm = 'crc32' | 'sha256'

/**
 * Compute CRC16-CCITT checksum (polynomial 0x1021)
 * Used for confirmation codes - shorter than CRC32, sufficient for detecting human typing errors
 *
 * @param data - The data to checksum
 * @returns 16-bit checksum as 4-character hex string (e.g., "A1B2")
 */
function crc16(data: Uint8Array): string {
  let crc = 0xFFFF; // Initial value
  const polynomial = 0x1021; // CRC16-CCITT polynomial

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ polynomial;
      } else {
        crc = crc << 1;
      }
      crc &= 0xFFFF; // Keep it 16-bit
    }
  }

  // Return as 4-character hex string (lowercase)
  return crc.toString(16).padStart(4, '0');
}

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
  const knownFields = ['type', 'mode', 'sessionId', 'sequence', 'currentPart', 'totalParts']

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
    { version: "4" }, // v4: Removed partChecksumMatch - receiver only sends feedback if part is valid
    { type: feedback.type },
    { mode: feedback.mode },
    { sessionId: feedback.sessionId.toString() },
    { sequence: feedback.sequence.toString() },
    { currentPart: feedback.currentPart.toString() },
    { totalParts: feedback.totalParts.toString() }
  ]

  // Create canonical string representation
  const canonicalString = JSON.stringify(fields)

  // Convert to Uint8Array using TextEncoder
  const encoder = new TextEncoder()
  const data = encoder.encode(canonicalString)

  // Compute CRC16 checksum (JavaScript implementation - 4 hex chars, no WASM needed)
  // CRC16 is sufficient for detecting human typing errors and is shorter than CRC32
  const checksum = crc16(data)

  // Format as user-friendly code: uppercase hex with hyphen (e.g., "AB-CD")
  const upperChecksum = checksum.toUpperCase()
  return upperChecksum.slice(0, 2) + '-' + upperChecksum.slice(2)
}
