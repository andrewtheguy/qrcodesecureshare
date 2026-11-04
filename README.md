# QR Secure Share

Offline file transfer and QR code generation. Share files between devices using animated QR codes with no internet required.

**Demo: [qrsecure.kuvi.dev](https://qrsecure.kuvi.dev/)**

## Features

### Text QR Generator
- Generate QR codes from text or URLs

### Offline File Transfer
- Transfer files using QR codes only - no internet, servers, or third-party services
- Fountain codes (LT codes) for robust large file transfers with error correction
- Sequential QR mode for simpler transfers
- CRC32 checksums for data integrity verification

### QR Scanner
- Camera-based scanning with rxing-reader WASM
- Image upload support

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS + Radix UI
- **QR Scanning**: `@andrewtheguy/rxing-wasm` from [rxing-reader](https://github.com/andrewtheguy/rxing-reader)
- **QR Generation**: `@andrewtheguy/fast-qr-wasm` from [fast_qr](https://github.com/andrewtheguy/fast_qr)
- **Binary QR Transport**: Fountain transfer worker path only (raw byte mode)
- **Fountain Codes**: Custom Rust/WASM implementation ([architecture docs](docs/fountain-code-architecture.md))

## Prerequisites

- [Bun](https://bun.sh) (the version in `packageManager` in `package.json`)
- [rustup](https://rustup.rs); `wasm/fountain/rust-toolchain.toml` pins the
  toolchain and the `wasm32-unknown-unknown` target, and `wasm-pack` comes from
  the devDependencies

## Installation

```bash
# Clone and install
git clone <repository-url>
cd qrcodesecureshare
bun install

# Build the fountain WASM module (once, and after every change under wasm/)
bun run build:wasm

# Development
bun run dev

# Production build (builds the WASM module first)
bun run build
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
├── utils/                  # WASM bindings and helpers
└── workers/                # Web Workers (QR scanning, decoding)

wasm/
└── fountain/               # LT fountain codes implementation (Rust → WASM)
```

## Performance

- QR decoding runs in a Web Worker that reads one camera frame at a time and
  skips to the newest frame when it frees up.
- The file-transfer receiver offers every new camera frame; the other scanners
  read at most 8 to 10 frames per second.
- Phones ask the camera for a lower resolution while receiving a file.

Planned work is in [docs/roadmap.md](docs/roadmap.md).

## Security

- **Offline by design**: No servers or internet required for file transfers
- **Local processing**: All QR operations happen in-browser via WebWorkers
- **No intermediaries**: Data stays on participating devices only
- **Integrity checks**: CRC32 checksums verify transfer completeness

## Development

```bash
# Run development server
bun run dev

# Rust tests and clippy for wasm/fountain
bun run test
bun run clippy

# Lint (Biome) and type-check
bun run lint
bunx tsc -b

# Format and apply safe fixes
bun run format

# Build WASM only
bun run build:wasm
```

The QR reader WASM is built and published from
[andrewtheguy/rxing-reader](https://github.com/andrewtheguy/rxing-reader); this
app consumes it as the pinned package `@andrewtheguy/rxing-wasm`. The QR
generator WASM is built and published from
[andrewtheguy/fast_qr](https://github.com/andrewtheguy/fast_qr); this app
consumes it as the pinned package `@andrewtheguy/fast-qr-wasm`. Both are
pulled in as GitHub release tarball URLs declared in `package.json`; to move to
a new release, run `bun add <release tarball URL>`. `bun run build:wasm` builds
only the in-repo `wasm/fountain` crate.

## Deployment

```bash
# Build for production
bun run build

# Preview build locally
bun run preview

# Deploy dist/ folder to any static hosting
```

### Cloudflare Pages

- Build command `bun run build:cloud`, output directory `dist`, root directory
  `/`. Set `BUN_VERSION` to the version in `packageManager` in `package.json`.
- `cloud_build.sh` installs rustup with no default toolchain, runs
  `rustup toolchain install` in `wasm/fountain` to get the toolchain and target
  its `rust-toolchain.toml` pins, then runs `bun run build`.
- `wasm-pack` downloads its binary in a postinstall script, which Bun runs only
  because `package.json` lists it in `trustedDependencies`.

## License

MIT License - see LICENSE file for details.
