import { type ClassValue, clsx } from "clsx"
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


/**
 * Detects if the current device is likely mobile by combining touch support,
 * coarse pointer detection, and mobile user-agent heuristics. Falls back to
 * viewport size only when touch is present but pointer metadata is unavailable.
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }

  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const hasCoarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)

  if (mobileUserAgent) {
    return true
  }

  if (hasTouch && hasCoarsePointer) {
    return true
  }

  if (hasTouch) {
    const prefersCompactViewport = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : window.innerWidth < 900
    return prefersCompactViewport
  }

  return false
}

/**
 * Detects if the current device is running iOS
 * @returns true if iOS device is detected
 */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
}
