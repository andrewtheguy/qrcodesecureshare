/**
 * Hardcoded RSA Public Key for Asymmetric Encryption
 *
 * This public key is used to encrypt files when asymmetric encryption is selected.
 * The corresponding private key is required to decrypt the files.
 *
 * To generate a new key pair, run: node generate-keys.cjs
 */

export const PUBLIC_KEY_JWK = {
  "kty": "RSA",
  "n": "0GudZpAbMFCcmvgG99Sgw8l0O5SPcJVLqJLOUXrvP49YxdXQ5i9SSTC276WgEdHREdf20kSPil0VQDk0c-4swvVRTw-zNb5UEILblKcAAKazOCF6Hfirz5H-K7gB1-2VDeznIoA4xbVIm-mQ4eQyGHBm-_fHMR89VLlWnitFxAEstIKn3hS3vz1-n1oUm7b0QzMtURla7GKeS9ZHey_tYeJf2Fr7ns5hFG_kBjow-aHRoN4jN2frKHJZuWi9ihOeJACxrzECvUMuANXIMFIfejo0WCrKNKbaYouPPMADfLnIlvzVTEW7GHZMDRhjA75PBTdM9HgvNupxG6FF3yzgxw",
  "e": "AQAB",
  "alg": "RSA-OAEP-256",
  "ext": true,
  "key_ops": [
    "encrypt"
  ]
} as JsonWebKey;
