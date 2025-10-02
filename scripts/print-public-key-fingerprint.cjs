#!/usr/bin/env node

// Prints the fingerprint (first 8 bytes of SHA-256 of n.e) of the current hardcoded public key
// Usage: node scripts/print-public-key-fingerprint.cjs
// Or (after script entry added) via: npm run fingerprint

const path = require('path')
const fs = require('fs')

// Resolve the TS source file. We read it as text to avoid requiring TS transpilation.
const publicKeyPath = path.join(process.cwd(), 'src', 'config', 'publicKey.ts')

if (!fs.existsSync(publicKeyPath)) {
  console.error('publicKey.ts not found at expected path:', publicKeyPath)
  process.exit(1)
}

const fileContents = fs.readFileSync(publicKeyPath, 'utf8')
// Very basic extraction of JSON object assigned to PUBLIC_KEY_JWK. Assumes formatting similar to repo.
const match = fileContents.match(/PUBLIC_KEY_JWK\s*=\s*({[\s\S]*?})\s+as\s+JsonWebKey/)
if (!match) {
  console.error('Could not locate PUBLIC_KEY_JWK object in publicKey.ts')
  process.exit(1)
}

let jwk
try {
  // eslint-disable-next-line no-eval -- controlled extraction of static object literal
  jwk = eval('(' + match[1] + ')')
} catch (e) {
  console.error('Failed to evaluate PUBLIC_KEY_JWK object:', e.message)
  process.exit(1)
}

if (!jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
  console.error('JWK missing n or e fields')
  process.exit(1)
}

const crypto = require('crypto')
const hash = crypto.createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest()
const fingerprint = Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')

console.log(fingerprint)
