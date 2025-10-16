#!/usr/bin/env node

// Prints the OpenSSH-style SHA256 fingerprint of an RSA public JWK.
// Input precedence:
// 1. If first CLI arg is '-' OR stdin is piped (non-TTY) -> read JWK JSON from stdin.
// 2. Otherwise extract PUBLIC_KEY_JWK from src/config/publicKey.ts (legacy behavior).
// Logic mirrors src/utils/fingerprint.ts:getJwkSshFingerprint:
//   1. Canonical JSON of {kty,n,e}
//   2. SHA-256 digest over UTF-8 bytes of that canonical string
//   3. Base64 (standard, no padding) of digest
//   4. Output formatted as: SHA256:<fingerprint>
// Usage examples:
//   node scripts/print-public-key-fingerprint.cjs
//   npm run fingerprint
//   cat public.jwk.json | node scripts/print-public-key-fingerprint.cjs
//   node scripts/print-public-key-fingerprint.cjs - < public.jwk.json
// Stdin may be a full public or private RSA JWK; only kty,n,e are used.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

function computeFingerprintFromJwk(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Input is not an object')
  if (obj.kty !== 'RSA') throw new Error('Unsupported key type (expected RSA)')
  if (typeof obj.n !== 'string' || typeof obj.e !== 'string') throw new Error('JWK missing n or e')
  const canonical = JSON.stringify({ kty: obj.kty, n: obj.n, e: obj.e })
  const digestB64 = crypto
    .createHash('sha256')
    .update(canonical, 'utf8')
    .digest('base64')
    .replace(/=+$/, '')
  return `SHA256:${digestB64}`
}

function loadFromPublicKeyTs() {
  const publicKeyPath = path.join(process.cwd(), 'src', 'config', 'publicKey.ts')
  if (!fs.existsSync(publicKeyPath)) {
    throw new Error('publicKey.ts not found at expected path: ' + publicKeyPath)
  }
  const fileContents = fs.readFileSync(publicKeyPath, 'utf8')
  const match = fileContents.match(/PUBLIC_KEY_JWK\s*=\s*({[\s\S]*?})\s+as\s+JsonWebKey/)
  if (!match) throw new Error('Could not locate PUBLIC_KEY_JWK object in publicKey.ts')
  let jwk
  try {
    // Controlled extraction of static object literal
    jwk = eval('(' + match[1] + ')')
  } catch (e) {
    throw new Error('Failed to evaluate PUBLIC_KEY_JWK object: ' + e.message)
  }
  return computeFingerprintFromJwk(jwk)
}

function processJsonInput(jsonString) {
  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (e) {
    throw new Error('Stdin is not valid JSON: ' + e.message)
  }
  return computeFingerprintFromJwk(parsed)
}

function output(fp) {
  console.log(fp)
}

const wantsStdin = process.argv[2] === '-' || !process.stdin.isTTY

if (wantsStdin) {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', () => {
    data = data.trim()
    if (!data) {
      console.error('No data received on stdin')
      process.exit(1)
    }
    try {
      const fp = processJsonInput(data)
      output(fp)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
  })
  process.stdin.resume()
} else {
  try {
    const fp = loadFromPublicKeyTs()
    output(fp)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
