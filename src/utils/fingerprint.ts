// Unified public key fingerprint utility (OpenSSH-like format)
// Produces: SHA256:<base64(no padding)>  (hash over canonical JSON {kty,n,e} for RSA)
// We intentionally drop '=' padding to mimic OpenSSH style fingerprints.
// Simplified: only provide an OpenSSH-style SHA256 fingerprint (no legacy MD5-style output).

function bytesToBase64NoPad(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/=+$/,'') // remove padding
}


// Helper to canonicalize supported JWKs (currently RSA only)
function canonicalizePublicJwk(parsed: any): string {
  if (parsed.kty === 'RSA' && parsed.n && parsed.e) {
    return JSON.stringify({ kty: parsed.kty, n: parsed.n, e: parsed.e })
  }
  throw new Error('Unsupported key type or missing public components for fingerprint')
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Ensure we pass a plain ArrayBuffer (avoid potential SharedArrayBuffer typing issues)
  const copy = new Uint8Array(bytes) // copies into a fresh ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', copy)
  return new Uint8Array(digest)
}

export interface JwkFingerprint {
  sshSha256: string        // e.g. SHA256:AbCdEf...
  algorithm: 'SHA-256'
  canonical: string        // canonical JSON used for hashing
}

export async function getJwkSshFingerprint(jwkString: string): Promise<string> {
  // Convenience wrapper returning only the SSH-style string
  const fp = await computeJwkFingerprint(jwkString)
  return fp.sshSha256
}

export async function computeJwkFingerprint(jwkString: string): Promise<JwkFingerprint> {
  let parsed: any
  try {
    parsed = JSON.parse(jwkString)
  } catch {
    throw new Error('Private key is not valid JSON')
  }
  const canonical = canonicalizePublicJwk(parsed)
  const data = new TextEncoder().encode(canonical)
  const digest = await sha256(data)
  const sshSha256 = 'SHA256:' + bytesToBase64NoPad(digest)
  return { sshSha256, algorithm: 'SHA-256', canonical }
}
