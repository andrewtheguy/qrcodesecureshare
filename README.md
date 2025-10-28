# QR Secure Share

🔐 **Zero-Knowledge End-to-End Encrypted** file sharing via QR codes. Transfer files securely between devices with or without internet - use encrypted server uploads, direct WebRTC connections, or completely offline QR code transfers with no third-party involvement.

## 🚀 Features

### ✉️ Text QR Generator
- Ability to function as a generic text QR code generator with no encryption for quick sharing of small text snippets or URLs.

### 🔐 **Multiple Encryption Modes for Online Methods**
- **Symmetric Encryption**: AES-GCM with passphrase embedded in QR code
- **Asymmetric Encryption**: RSA-OAEP + AES-GCM hybrid encryption with hardcoded public key

### 📱 **File Transfer Methods**
- **Server Upload** 🔒: Upload encrypted files to server and generate QR codes with download links
- **WebRTC** 🔒: Direct peer-to-peer encrypted file transfer
- **Offline Transfer** 📱: Transfer files using QR codes alone - no internet, servers, or third-party services required
  - **Fountain Codes**: Robust QR code sequences for large files with error correction
  - **Sequential QR**: Multiple QR codes for larger data with progress tracking

### 🎯 **Core Functionality**
- **Generate QR Codes**: Create QR codes from text or files
- **Upload Files**: Secure file upload with encryption
- **Scan QR Codes**: Built-in QR scanner
- **Offline Mode**: Full functionality without internet
- **PWA Support**: Install as a web app on mobile devices

### 🔒 **Zero-Knowledge Security**
- **Client-side encryption**: Files are encrypted in your browser before any transfer
- **Never unencrypted**: Data never leaves your device without encryption
- **You control the keys**: Encryption keys are generated locally and never transmitted
- **Multiple algorithms**: AES-GCM symmetric + RSA-OAEP asymmetric encryption
- **Private key management**: Secure handling of asymmetric encryption keys

## 📋 Prerequisites

- Node.js 18+
- npm or yarn

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd qrcodesecureshare
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   npm run preview
   ```

## 🔑 Key Management For Asymmetric Encryption

The app comes pre-configured with my own encryption key pairs for my website, you should replace it with your own by generating a new pair:

1. **Generate new key pair**
   ```bash
   npm run generate-keys
   ```

2. **View public key fingerprint**
   ```bash
   npm run fingerprint
   ```

3. **Update keys** (if generating new ones):
   - Public key: Update `src/config/publicKey.ts`
   - Private key: Save it to a secure location, you'll need it to decrypt files encrypted with the public key above. Never commit it to the repo.

## 📖 Usage

### Basic File Sharing

1. **Upload a file** using the "Upload File" tab
2. **Choose transfer method**:
   - **Server Upload** 🔒: Encrypted upload with QR code containing download link
   - **WebRTC** 🔒: Direct encrypted peer-to-peer transfer
   - **Offline Transfer**: Raw data transfer via QR codes (no encryption)
3. **Choose encryption mode** (for Server/WebRTC methods):
   - Symmetric (passphrase in QR)
   - Asymmetric (public/private key)
4. **Share the QR code** with the recipient
5. **Recipient scans** the QR code to download/decrypt

### Text Sharing

1. **Use "Generate QR Code"** tab for text
2. **Enter your text** and generate QR
3. **Share the QR code**

### Scanning QR Codes

1. **Use "Scan QR"** tab
2. **Allow camera access**
3. **Scan QR codes** to extract data

### Offline Transfer

1. **Use "Offline Transfer"** tab
2. **Choose transfer method** (Fountain Codes or Sequential QR)
3. **Send or receive** files using QR codes only - completely offline, no servers involved

## 🔐 Encryption Guide

### Symmetric Encryption (Default)
- Uses AES-GCM encryption
- Passphrase is embedded in the QR code
- Perfect for quick sharing between trusted parties

### Asymmetric Encryption
- Uses RSA-OAEP + AES-GCM hybrid encryption
- Public key is hardcoded in the app
- Private key is required for decryption
- Ideal for controlled distribution where you hold the private key

## 🏗️ Architecture

### Tech Stack
- **Frontend**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + Radix UI
- **QR Code Scanning**: ZXing WASM (high-performance WebAssembly-based scanner)
- **QR Code Generation**: qrcode library (for one-off QR code generation)
- **Binary Transfer**: Fountain codes (LT codes with Robust Soliton distribution) for efficient large file transfers
- **Encryption**: Web Crypto API (AES-GCM, RSA-OAEP)
- **P2P**: PeerJS for WebRTC
- **PWA**: Vite PWA plugin

### QR Code Implementation Details

**Current Scanning & Encoding:**
- **ZXing WASM**: Primary QR code scanner for all QR scanning operations, used throughout the application (src/workers/zxing-qr-scanner.worker.ts)
- **Fountain Code Encoding**: Using ZXing WASM for QR code generation for Binary-compatible encoding to eliminate the need for Base64
- **qrcode Library**: Retained for one-off QR code generation (simple text/URL QR codes)
- **qr-scanner Library**: Previously used, now replaced by ZXing WASM for better performance

**Future Plans:**
- Replace sequential scanning Base64 encoding with ZXing WASM encoder for binary mode transfers to provide even better performance and compatibility

### Key Components
- `Upload.tsx`: File upload and QR generation
- `Scan.tsx`: QR code scanning
- `OfflineTransfer.tsx`: P2P file transfer
- `OfflineQRMode.tsx`: Mode selection and metadata preparation for offline QR transfers
- `OfflineQRReceiver.tsx`: Metadata scanning and receiver component selection for offline QR transfers
- Various sender/receiver components for different transfer methods

## 🔋 Performance & Battery Optimization

QR code scanning is automatically optimized for mobile devices to reduce battery consumption and heat generation:

- **Reduced scan rates**: 8 fps on mobile vs 15+ fps on desktop for continuous scanning
- **Smart visual hints**: Highlights disabled on mobile to reduce rendering overhead
- **Resolution limiting**: Video resolution constrained to prevent unnecessary high-resolution processing
- **Adaptive optimization**: Different scan rates for different use cases (metadata vs. continuous scanning)

### Tips for Best Mobile Performance

- **Keep device steady**: Reduces missed scans and improves efficiency
- **Ensure good lighting**: Better lighting enables faster detection at lower scan rates
- **Position QR code properly**: Fill most of the camera view with the QR code
- **Trust the optimization**: The reduced scan rate (8 fps) is intentional for battery preservation and still provides excellent performance

These optimizations significantly reduce battery consumption and heat generation, especially during extended scanning sessions with Fountain Code transfers.

## 🔒 Security Considerations

- **Client-side encryption**: All encryption happens in the browser
- **No data storage**: Files are not stored on any server
- **Private keys**: Never transmitted or stored insecurely
- **HTTPS recommended**: Use HTTPS in production for WebRTC
- **Key management**: Keep private keys secure and offline

## 🚀 Deployment

### As a Web App
```bash
npm run build
# Deploy the dist/ folder to your web server
```

### Testing with Local Server
For reliable testing of the built application, use the provided test deployment script:
```bash
./scripts/test-deploy.sh
```
This script builds the project, serves it locally on port 6943 with caching disabled, and creates a Cloudflare tunnel for external access.

### As a PWA
The app includes PWA configuration and can be installed on mobile devices for offline use.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly (especially encryption features)
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

**Secure your file sharing with QR Secure Share!** 🔐📱
