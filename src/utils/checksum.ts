// SHA-256 checksum utility (browser WebCrypto)
// Returns lowercase hex string.

// Lightweight checksum utilities
// Default: CRC32 (fast, non-cryptographic). Optionally supports SHA-256 when stronger integrity needed.

let crc32Table: number[] | null = null

function makeCrc32Table(): number[] {
  const tbl: number[] = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    tbl[i] = c >>> 0
  }
  return tbl
}

function crc32(data: Uint8Array): string {
  if (!crc32Table) crc32Table = makeCrc32Table()
  let crc = 0 ^ (-1)
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crc32Table![(crc ^ data[i]) & 0xFF]
  }
  crc = (crc ^ (-1)) >>> 0
  return crc.toString(16).padStart(8, '0')
}

export type ChecksumAlgorithm = 'crc32' | 'sha256'

export async function computeChecksum(
  dataInput: Uint8Array | ArrayBuffer,
  algorithm: ChecksumAlgorithm = 'crc32'
): Promise<string> {
  const data = dataInput instanceof Uint8Array ? dataInput : new Uint8Array(dataInput)
  if (algorithm === 'crc32') return crc32(data)
  // SHA-256 path (slower, but cryptographically strong)
  const copy = new Uint8Array(data) // fresh ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}
