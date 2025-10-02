/**
 * Hardcoded RSA Public Key for Asymmetric Encryption
 *
 * This public key is used to encrypt files when asymmetric encryption is selected.
 * The corresponding private key is required to decrypt the files.
 *
 * To generate a new key pair, run: node generate-keys.cjs
 */

export const PUBLIC_KEY_JWK = {
  kty: "RSA",
  n: "pvxGMe0XpWly-q89xkSu2ymOnN9pW1fODL-lS86XEsdtVao9oY5NOj18u7QIprtSZYLgX2ZGaVCdoCjIKc5TuKSYBgh0AY_dEkSpdChTsUOduNG5B64Phatr2vBcpAfGdr_Y1oYwqd2axwZTjApJcnoG2b2yM2oUrEKXu8sDXMBBnrgm9OaLAWy8nx_B84GuxnbzSQVNs82rs7ybLFbvx5O3rdzoq74dfPKVUt8J_XiS8qL1xiZ5x9K0xfIXVxbEvHjAY5Ww52P1n3tKEh9YEyCL_EC3G_u_10n4Y88W5lDme-RACJ-kaO7vHga8mktI0nz88WJSzcZB8m15Nq-JiQ",
  e: "AQAB",
  alg: "RSA-OAEP-256",
  ext: true,
  key_ops: ["encrypt"],
} as JsonWebKey;
