# QR Secure Share

Offline file transfer and QR code generation. Share files between devices using animated QR codes with no internet required.

**Demo: [qrsecure.kuvi.app](https://qrsecure.kuvi.app/)**

## Features

### Text QR Generator
- Generate QR codes from text or URLs

### Offline File Transfer
- Transfer files using QR codes only - no internet, servers, or third-party services
- Fountain codes (LT codes) for robust large file transfers with error correction
- Sequential QR mode for simpler transfers
- CRC32 checksums for data integrity verification

### QR Scanner
- Camera-based scanning with ZXing WASM
- Image upload support

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS + Radix UI
- **QR Scanning**: ZXing WASM (WebAssembly)
- **QR Generation**: fast_qr-based Rust/WASM generator
- **Binary QR Transport**: Fountain transfer worker path only (raw byte mode)
- **Fountain Codes**: Custom Rust/WASM implementation ([architecture docs](docs/fountain-code-architecture.md))

## Prerequisites

- Node.js 18+
- Rust toolchain with `wasm-pack` (for building fountain-wasm)

## Installation

```bash
# Clone and install
git clone <repository-url>
cd qrcodesecureshare
npm install

# Development (uses pre-built WASM)
npm run dev

# Production build (rebuilds WASM)
npm run build
```

## Usage

### Generate QR Code
1. Go to "Generate QR Code" tab
2. Enter text or URL
3. Download or share the QR code

### Scan QR Code
1. Go to "Scan QR" tab
2. Use camera or upload an image
3. Scanned data is displayed and can be copied

### Send File (Offline Transfer)
1. Go to "Send File" tab
2. Select a file to transfer
3. Choose transfer mode (Fountain Code recommended for large files)
4. Display animated QR codes for receiver to scan

### Receive File
1. Go to "Send File" > "Receive a file"
2. Scan the metadata QR code from sender
3. Continue scanning animated QR codes until transfer completes
4. Download the reconstructed file

## Project Structure

```
src/
├── components/
│   ├── GenerateQR.tsx      # Text/URL QR generator
│   ├── Scan.tsx            # QR scanner (camera/upload)
│   ├── OfflineTransfer.tsx # File transfer workflow
│   ├── fountain_qr/        # Fountain code transfer UI
│   └── ui/                 # Shared UI components (shadcn)
├── workers/                # Web Workers (QR scanning, decoding)
└── wasm/                   # WASM bindings

rust/
└── fountain-wasm/          # LT fountain codes implementation
```

## Performance

Mobile-optimized scanning:
- Reduced scan rates (8 fps mobile, 15+ fps desktop)
- Resolution limiting to reduce processing overhead
- Smart throttling for battery preservation

## Security

- **Offline by design**: No servers or internet required for file transfers
- **Local processing**: All QR operations happen in-browser via WebWorkers
- **No intermediaries**: Data stays on participating devices only
- **Integrity checks**: CRC32 checksums verify transfer completeness

## Development

```bash
# Run development server
npm run dev

# Run tests (Rust)
npm run test

# Lint
npm run lint

# Build WASM only
npm run build:wasm
```

## Deployment

```bash
# Build for production
npm run build

# Preview build locally
npm run preview

# Deploy dist/ folder to any static hosting
```

See [CLOUDFLARE_DEPLOY.md](docs/CLOUDFLARE_DEPLOY.md) for Cloudflare Pages deployment.

## License

MIT License - see LICENSE file for details.
