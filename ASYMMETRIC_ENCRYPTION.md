# Asymmetric Encryption Guide

This application supports asymmetric (public/private key) encryption for file uploads with a **hardcoded public key**.

## How It Works

### Symmetric Encryption (Default)
- Uses **AES-GCM** with a randomly generated passphrase
- Same passphrase is used for both encryption and decryption
- Passphrase is embedded in the QR code

### Asymmetric Encryption (Hardcoded Key)
- Uses **RSA-OAEP** + **AES-GCM** hybrid encryption
- File is encrypted with a **hardcoded public key** in the source code
- Only the corresponding private key can decrypt it
- Private key is **NOT** stored in the QR code (manual entry required)
- QR code contains only the download URL and filename

## Setup Instructions

### Step 1: Generate RSA Key Pair (One-time setup)

Run the key generation script:

```bash
node generate-keys.cjs
```

This will output:
- **Public Key** (JWK format) - for encryption (to be hardcoded)
- **Private Key** (JWK format) - for decryption (keep secure!)

### Step 2: Update Hardcoded Public Key (If generating new keys)

1. Copy the **public key** from the output
2. Update `src/config/publicKey.ts` with the new key
3. Save the **private key** to `PRIVATE_KEY.md` (this file is gitignored)

**Note:** The app already has a public key configured. You only need to generate a new key pair if you want to change it.

### Step 3: Upload File

1. Select **"Asymmetric (Public/Private Key)"** encryption mode
2. Upload your file (it will be encrypted with the hardcoded public key)
3. Share the QR code - it contains only the download URL and filename
4. **Keep the private key secure!** (stored in `PRIVATE_KEY.md`)

### Step 4: Decrypt File

1. Scan the QR code
2. Click **"Show"** next to "Private Key (JWK)"
3. Paste the **private key** from `PRIVATE_KEY.md`
4. Click **"Download Original File"** to decrypt

## Security Considerations

### Advantages of Asymmetric Encryption
- ✅ Private key never leaves your device
- ✅ QR code can be shared publicly without revealing decryption key
- ✅ Only the person with the private key can decrypt
- ✅ Good for controlled distribution (you hold the private key)

### When to Use Each Method

**Use Symmetric (Passphrase):**
- Quick sharing between trusted parties
- One-time file transfers
- When you want everything in the QR code

**Use Asymmetric (Hardcoded Public Key):**
- When you control both encryption and decryption
- QR codes shared publicly without revealing decryption key
- Higher security - private key never transmitted
- Multiple file uploads with same key pair
- Good for organizational use where you hold the private key

## Technical Details

### Encryption Process (Asymmetric)
1. Generate random AES-256 key
2. Encrypt file with AES-GCM
3. Encrypt AES key with RSA-OAEP (2048-bit) using hardcoded public key
4. Upload: `[encrypted_aes_key_length][encrypted_aes_key][iv][encrypted_data]`

### Decryption Process (Asymmetric)
1. Extract encrypted AES key from file
2. Decrypt AES key using RSA private key
3. Decrypt file data using recovered AES key

This hybrid approach combines RSA's security with AES's performance.

## Example Workflow

### Scenario: Secure Public File Sharing

**Organization wants to share encrypted files via public QR codes:**

1. **One-time setup:**
   - Run `node generate-keys.cjs` to generate key pair
   - Public key is hardcoded in `src/config/publicKey.ts`
   - Private key saved in `PRIVATE_KEY.md` (kept secure, not committed)

2. **Upload files:**
   - Select asymmetric encryption mode
   - Upload files (encrypted with hardcoded public key)
   - Display QR codes publicly (posters, websites, etc.)

3. **Authorized users decrypt:**
   - Scan QR code
   - Enter private key (shared securely with authorized users only)
   - Download decrypted file

**Result:** QR codes can be shared publicly, but only users with the private key can decrypt the files.

## File Locations

- **Public Key (hardcoded)**: `src/config/publicKey.ts`
- **Private Key (secure)**: `PRIVATE_KEY.md` (gitignored)
- **Key Generator**: `generate-keys.cjs`
- **Git Ignore**: Private key files are excluded from version control

## Security Best Practices

1. ✅ Keep `PRIVATE_KEY.md` secure and offline
2. ✅ Never commit private keys to git (already gitignored)
3. ✅ Share private key only with authorized users via secure channels
4. ✅ Regenerate keys periodically for better security
5. ✅ Use strong access controls for the private key file
