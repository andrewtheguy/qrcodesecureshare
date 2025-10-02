#!/usr/bin/env node

/**
 * Generate RSA Key Pair for Asymmetric Encryption
 * Usage:
 *   npm run generate-keys
 *   (or) node scripts/generate-keys.cjs
 */

const crypto = require('crypto');

async function generateRSAKeyPair() {
  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // Convert to JWK format for Web Crypto API
  const publicKeyJwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
  const privateKeyJwk = crypto.createPrivateKey(privateKey).export({ format: 'jwk' });

  // Add required fields for Web Crypto API
  publicKeyJwk.alg = 'RSA-OAEP-256';
  publicKeyJwk.ext = true;
  publicKeyJwk.key_ops = ['encrypt'];

  privateKeyJwk.alg = 'RSA-OAEP-256';
  privateKeyJwk.ext = true;
  privateKeyJwk.key_ops = ['decrypt'];

  // Compute public and private key fingerprints.
  // Public fingerprint (legacy short hex - first 8 bytes, retained for continuity)
  const hash = crypto.createHash('sha256').update(`${publicKeyJwk.n}.${publicKeyJwk.e}`).digest();
  const publicKeyFingerprint = Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Full canonical public portion fingerprint (Base64 of SHA-256 over JSON of {kty,n,e})
  const canonicalPublic = JSON.stringify({ kty: publicKeyJwk.kty, n: publicKeyJwk.n, e: publicKeyJwk.e });
  const fullPublicDigest = crypto.createHash('sha256').update(canonicalPublic).digest();
  const fullPublicFingerprintB64 = fullPublicDigest.toString('base64');

  // Since private fingerprint for identification should NOT expose private fields,
  // we use the same canonical public portion (matching the runtime app logic) to keep identity consistent.
  // This is effectively the same as fullPublicFingerprintB64.
  const privateKeyFingerprintB64 = fullPublicFingerprintB64;

  console.log('\n=== RSA Key Pair Generated ===\n');
  console.log('Public Key (copy to src/config/publicKey.ts):');
  console.log('----------------------------------------');
  console.log(JSON.stringify(publicKeyJwk, null, 2));
  console.log('\n');
  console.log('Private Key (save securely, DO NOT commit to git) - MINIFIED JSON:');
  console.log('----------------------------------------');
  // Output intentionally unformatted (single line) to reduce accidental whitespace issues when storing
  console.log(JSON.stringify(privateKeyJwk));
  console.log('\n');
  console.log('Public Key Fingerprint (short hex, first 8 bytes of SHA-256 of n.e):');
  console.log('----------------------------------------');
  console.log(publicKeyFingerprint);
  console.log('\n');
  console.log('Public Key Fingerprint (full Base64 SHA-256 over canonical {kty,n,e}):');
  console.log('----------------------------------------');
  console.log(fullPublicFingerprintB64);
  console.log('\n');
  console.log('Private Key Fingerprint (mirrors public canonical fingerprint for identification):');
  console.log('----------------------------------------');
  console.log(privateKeyFingerprintB64);
  console.log('\n');
  console.log('📝 Instructions:');
  console.log('1. Copy the Public Key JSON into src/config/publicKey.ts');
  console.log('2. Record the Public Key Fingerprints (short + full Base64)');
  console.log('3. Use the full Base64 fingerprint to match the key in the app UI');
  console.log('4. Store the Private Key securely (needed to decrypt files)');
  console.log('5. DO NOT commit the private key to version control!');
  console.log('\n');
}

generateRSAKeyPair();
