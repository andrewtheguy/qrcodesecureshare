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

// (Legacy computePublicKeyFingerprint removed in favor of SSH-style fingerprint from utils/fingerprint.ts)