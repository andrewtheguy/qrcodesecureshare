# QR Secure Share

QR-based offline file transfer and text QR generation. Share files between devices with no internet required using animated QR codes, or create simple text/URL QR codes for quick sharing.

## 🚀 Features

### ✉️ Text QR Generator
- Generate QR codes from text or URLs for quick sharing
- Large text can be compressed into a single QR (binary payload) for a second attempt at fitting into one code

### 📱 Offline QR File Transfer
- Transfer files using QR codes only - no internet, servers, or third-party services required
- **Fountain Codes**: Robust QR code sequences for large files with error correction
- **Sequential QR**: Multiple QR codes for larger data with progress tracking

### 🎯 Core Functionality
- **Generate QR Codes**: Create QR codes from text
- **Scan QR Codes**: Built-in QR scanner (camera or image upload)
- **Offline Mode**: Full offline file transfer capability
- **PWA Support**: Install as a web app on mobile devices

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

## 📖 Usage

### Text Sharing

1. **Use "Generate QR Code"** tab
2. **Enter your text** and generate QR
3. **Share the QR code**
4. **If text is too long**, use the in-place "Generate Compressed QR" option to pack more text into a single code

### Scanning QR Codes

1. **Use "Scan QR"** tab
2. **Allow camera access** or upload a QR image
3. **Scan QR codes** to extract data

### Offline QR File Transfer

1. **Use "Offline QR File Transfer"** tab (📤 Offline Transfer)
2. **Choose role**: Send a file or Receive a file
3. **Send mode**: Select a file to encode into animated QR codes, choose transfer mode (Fountain Code Recommended/Basic or Sequential)
4. **Receive mode**: Scan the metadata QR code and watch the receiver scan the animated QR codes
5. **Transfer completely offline** - no internet, servers, or services required

## 🏗️ Architecture

### Tech Stack
- **Frontend**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + Radix UI
- **QR Code Scanning**: ZXing WASM (high-performance WebAssembly-based scanner)
- **QR Code Generation**: qrcode library (for one-off QR code generation)
- **Binary Transfer**: Fountain codes (LT codes with Robust Soliton distribution) for efficient large file transfers
- **PWA**: Vite PWA plugin

### QR Code Implementation Details

**Current Scanning & Encoding:**
- **ZXing WASM**: Primary QR code scanner for all QR scanning operations, used throughout the application (src/workers/zxing-qr-scanner.worker.ts)
- **Fountain Code Encoding**: Using ZXing WASM for QR code generation for binary-compatible encoding to eliminate the need for Base64
- **qrcode Library**: Retained for one-off QR code generation (simple text/URL QR codes)
- **qr-scanner Library**: Previously used, now replaced by ZXing WASM for better performance

**Future Plans:**
- Replace sequential scanning Base64 encoding with ZXing WASM encoder for binary mode transfers to provide even better performance and compatibility

### Key Components
- `GenerateQR.tsx`: Text/URL QR code generator with compression support
- `Scan.tsx`: QR code scanning from camera or image upload
- `OfflineTransfer.tsx`: Offline QR file transfer workflow (Send/Receive mode selection)
- `OfflineQRMode.tsx`: Transfer mode selection and metadata QR generation for offline file transfers
- `OfflineQRReceiver.tsx`: Receiver-side metadata scanning and data collection for offline transfers
- `FountainQRSender.tsx` / `FountainQRReceiver.tsx`: Fountain code-based transfer implementation
- `SequentialQRSender.tsx` / `SequentialQRReceiver.tsx`: Sequential QR code transfer implementation

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

- **Offline by design**: Offline QR transfers do not require servers or internet access
- **No intermediaries**: Transfer data stays only on the participating devices - never transmitted through third parties
- **Camera permissions**: The scanner only uses camera access while actively scanning
- **Compressed text QR**: Uses gzip compression with a binary payload header (`CMPQR1:`) that this app can auto-decompress on scan
- **Data integrity**: Fountain and Sequential modes use CRC32 checksums to verify transfer completeness
- **Local processing**: All QR code generation and scanning happens locally in the browser (WebWorkers)

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
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

**Share files offline with QR Secure Share!** 📷📁
