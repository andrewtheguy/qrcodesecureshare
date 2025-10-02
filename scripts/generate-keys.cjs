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

  // Compute fingerprint (first 8 bytes hex of SHA-256 over n.e like in app)
  const hash = crypto.createHash('sha256').update(`${publicKeyJwk.n}.${publicKeyJwk.e}`).digest();
  const publicKeyFingerprint = Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');

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
  console.log('Public Key Fingerprint:');
  console.log('----------------------------------------');
  console.log(publicKeyFingerprint);
  console.log('\n');
  console.log('📝 Instructions:');
  console.log('1. Copy the Public Key JSON into src/config/publicKey.ts');
  console.log('2. Record the Public Key Fingerprint (verify it matches when scanning)');
  console.log('3. Store the Private Key securely (needed to decrypt files)');
  console.log('4. DO NOT commit the private key to version control!');
  console.log('\n');
}

generateRSAKeyPair();
