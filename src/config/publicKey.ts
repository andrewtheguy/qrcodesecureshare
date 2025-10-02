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
  "n": "2d9PQPJ04m8vnABGUEB_YPRG-NC9LvOzHGksmRNmRM36Pf1Ag7zl3pAcVok6ze2FUL1sKNQ1AzTKZfma0Y-hy_4tO6V2LLAoKUg6IaLJwFLKQraiz6AJoes1FDTU3_DjuctI1aXhDqyHJVSByYfYNoC3ArIdtbssRyCjyqj29Bm4UtPGBCC1IwQH7ZNX7oVzMn8DM2Pz3Swn-0-JctEMTqn7Ykk0Y5ux2vTvBhbCw9AeTj5Rgv_Fl2t7ereMu4rGRfuY_fLA4V0tpUFSJAEwXDs_ln925_mB0l-yzxEJ-cZMDxE3fmAlYEgiLCwZEHc1cp5P2JYhHOn1MupH-T2rjQ",
  "e": "AQAB",
  "alg": "RSA-OAEP-256",
  "ext": true,
  "key_ops": [
    "encrypt"
  ]
} as JsonWebKey;
