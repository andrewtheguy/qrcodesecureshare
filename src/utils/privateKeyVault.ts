// Ephemeral in-tab private key vault.
// Now stores a non-extractable Web Crypto CryptoKey instead of raw JWK string.
// Goal: minimize exposure time of plaintext key material.
// Cleared on: manual clear, successful decryption (caller responsibility), inactivity timeout (caller), or tab unload.
// NOT persisted across reloads/new tabs.

let _privateKey: CryptoKey | null = null

/** Validate that the parsed JWK at least superficially looks like an RSA private key */
function validateRsaPrivateJwk(jwk: any) {
  if (!jwk || typeof jwk !== 'object') throw new Error('Invalid JWK: not an object')
  if (jwk.kty !== 'RSA') throw new Error('Invalid JWK: kty must be RSA')
  // Minimal required props for private RSA key used for RSA-OAEP decrypt
  const required = ['n', 'e', 'd']
  for (const field of required) {
    if (typeof jwk[field] !== 'string') throw new Error(`Invalid JWK: missing field ${field}`)
  }
}

/**
 * Import a JWK JSON string as a non-extractable CryptoKey and store it.
 * The original JWK string should be cleared by the caller after this resolves.
 */
export async function importAndSetPrivateKey(jwkString: string): Promise<CryptoKey> {
  let parsed: any
  try {
    parsed = JSON.parse(jwkString)
  } catch {
    throw new Error('Private key is not valid JSON')
  }
  validateRsaPrivateJwk(parsed)

  const key = await crypto.subtle.importKey(
    'jwk',
    parsed,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false, // extractable: false (cannot be re-exported)
    ['decrypt']
  )
  _privateKey = key
  return key
}

export function getPrivateKey(): CryptoKey | null {
  return _privateKey
}

export function clearPrivateKey() {
  _privateKey = null
}

// Best effort: clear on tab unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    _privateKey = null
  })
}
