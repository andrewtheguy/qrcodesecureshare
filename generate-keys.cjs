#!/usr/bin/env node

/**
 * Generate RSA Key Pair for Asymmetric Encryption
 * Run this script with: node generate-keys.js
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

  console.log('\n=== RSA Key Pair Generated ===\n');
  console.log('PUBLIC KEY (copy to src/config/publicKey.ts):');
  console.log('----------------------------------------');
  console.log(JSON.stringify(publicKeyJwk, null, 2));
  console.log('\n');
  console.log('PRIVATE KEY (save securely, DO NOT commit to git):');
  console.log('----------------------------------------');
  console.log(JSON.stringify(privateKeyJwk, null, 2));
  console.log('\n');
  console.log('PUBLIC KEY (one-line):');
  console.log('----------------------------------------');
  console.log(JSON.stringify(publicKeyJwk));
  console.log('\n');
  console.log('PRIVATE KEY (one-line):');
  console.log('----------------------------------------');
  console.log(JSON.stringify(privateKeyJwk));
  console.log('\n');
  console.log('📝 Instructions:');
  console.log('1. Copy the PUBLIC KEY to src/config/publicKey.ts');
  console.log('2. Save the PRIVATE KEY securely (you\'ll need it to decrypt files)');
  console.log('3. DO NOT commit the private key to version control!');
  console.log('\n');
}

generateRSAKeyPair();
