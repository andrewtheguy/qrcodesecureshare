import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}


export const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
    const encoder = new TextEncoder()
    const passphraseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    )

  // Some TS environments complain about Uint8Array subtype; pass ArrayBuffer explicitly
  const saltCopy = new Uint8Array(salt)
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
  salt: saltCopy,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

// Computes a short fingerprint (first 8 bytes hex of SHA-256 of "n.e") for an RSA public JWK.
// Throws an Error if required fields are missing or if digest fails.
export async function computePublicKeyFingerprint(jwk: { n: string; e: string }): Promise<string> {
  if (!jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || !jwk.n || !jwk.e) {
    throw new Error('computePublicKeyFingerprint: missing modulus (n) or exponent (e)')
  }

  const concat = `${jwk.n}.${jwk.e}`
  const data = new TextEncoder().encode(concat)
  let hashBuf: ArrayBuffer
  try {
    hashBuf = await crypto.subtle.digest('SHA-256', data)
  } catch (err) {
    throw new Error(`computePublicKeyFingerprint: failed to compute digest: ${(err as Error).message}`)
  }

  return Array.from(new Uint8Array(hashBuf).slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}