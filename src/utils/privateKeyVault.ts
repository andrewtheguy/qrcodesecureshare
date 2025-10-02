// Ephemeral in-tab private key vault.
// Stores the RSA private key (JWK string) only in module scope memory.
// Cleared on: manual clear, successful decryption, inactivity timeout (triggered externally), or tab unload.
// This does NOT persist across page reloads or new tabs.

let _privateKey: string | null = null

export function setPrivateKey(jwk: string) {
  _privateKey = jwk
}

export function getPrivateKey(): string | null {
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
  // Also clear if page becomes hidden for a long period (handled externally if desired)
}
