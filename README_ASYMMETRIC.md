# Quick Start: Asymmetric Encryption

## Overview

The app now supports **asymmetric encryption** with a hardcoded public key. This allows you to:
- Share QR codes publicly without revealing decryption credentials
- Only authorized users with the private key can decrypt files

## How to Use

### 1. Generate Keys (Already Done!)

The app comes with a pre-generated key pair:
- **Public key**: Hardcoded in `src/config/publicKey.ts` ✅
- **Private key**: Stored in `PRIVATE_KEY.md` (gitignored) 🔒

### 2. Upload Encrypted Files

1. Open the app
2. Select **"Asymmetric (Public/Private Key)"** encryption
3. Upload your file
4. Share the generated QR code anywhere

### 3. Decrypt Files

1. Scan the QR code
2. Click "Show" next to "Private Key (JWK)"
3. Paste the private key from `PRIVATE_KEY.md`
4. Click "Download Original File"

## When to Use Asymmetric Encryption

✅ **Use asymmetric encryption when:**
- You want to share QR codes publicly (posters, websites, social media)
- You need higher security (private key never transmitted)
- You control who can decrypt (share private key only with authorized users)
- Multiple files need the same encryption key

❌ **Use symmetric encryption (passphrase) when:**
- Quick one-time sharing
- Both parties need the credentials in the QR code
- Simpler setup is preferred

## Generate New Keys (Optional)

To generate your own key pair:

```bash
node generate-keys.cjs
```

Then update:
1. Copy public key → `src/config/publicKey.ts`
2. Copy private key → `PRIVATE_KEY.md`

## Security Notes

🔒 **Important:**
- `PRIVATE_KEY.md` is gitignored and will NOT be committed
- Keep the private key secure and share only via secure channels
- Anyone with the private key can decrypt all files encrypted with the corresponding public key

For detailed documentation, see [ASYMMETRIC_ENCRYPTION.md](./ASYMMETRIC_ENCRYPTION.md)
