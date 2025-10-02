/**
 * Utility to generate RSA key pair for asymmetric encryption
 * Run this in browser console to generate keys for testing
 */

export async function generateRSAKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  )

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

  console.log('=== RSA Key Pair Generated ===\n')
  console.log('PUBLIC KEY (use for encryption):')
  console.log(JSON.stringify(publicKeyJwk, null, 2))
  console.log('\n')
  console.log('PRIVATE KEY (use for decryption):')
  console.log(JSON.stringify(privateKeyJwk, null, 2))
  console.log('\n')
  console.log('PUBLIC KEY (one-line, for pasting):')
  console.log(JSON.stringify(publicKeyJwk))
  console.log('\n')
  console.log('PRIVATE KEY (one-line, for pasting):')
  console.log(JSON.stringify(privateKeyJwk))

  return {
    publicKey: publicKeyJwk,
    privateKey: privateKeyJwk
  }
}

// Make it available in window for easy access in browser console
if (typeof window !== 'undefined') {
  (window as any).generateRSAKeyPair = generateRSAKeyPair
}
