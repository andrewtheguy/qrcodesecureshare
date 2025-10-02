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

  // Compute canonical OpenSSH-style SHA256 fingerprint (mirrors getJwkSshFingerprint & print-public-key-fingerprint.cjs)
  const canonicalPublic = JSON.stringify({ kty: publicKeyJwk.kty, n: publicKeyJwk.n, e: publicKeyJwk.e });
  const digest = crypto.createHash('sha256').update(canonicalPublic, 'utf8').digest('base64').replace(/=+$/, '');
  const sshStyleFingerprint = `SHA256:${digest}`;

  // Derive an equivalent fingerprint path via the private JWK's public components to assert consistency.
  const privateDerivedCanonical = JSON.stringify({ kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e });
  const privateDerived = 'SHA256:' + crypto.createHash('sha256').update(privateDerivedCanonical, 'utf8').digest('base64').replace(/=+$/, '');
  if (privateDerived !== sshStyleFingerprint) {
    throw new Error('Public/private key fingerprint mismatch – aborting.');
  }

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
  console.log('Public and Private Key Fingerprint (OpenSSH-style SHA256 over canonical {kty,n,e}):');
  console.log('----------------------------------------');
  console.log(sshStyleFingerprint);
  console.log('\n');
  console.log('📝 Instructions:');
  console.log('1. Copy the Public Key JSON into src/config/publicKey.ts');
  console.log('2. Record the SSH-style fingerprint (SHA256:...) and share for verification');
  console.log('3. This fingerprint is derived from canonical JSON of {kty,n,e} (order fixed)');
  console.log('4. Store the Private Key securely (needed to decrypt files)');
  console.log('5. DO NOT commit the private key to version control!');
  console.log('\n');
}

generateRSAKeyPair();
