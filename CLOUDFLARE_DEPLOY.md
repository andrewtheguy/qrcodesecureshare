# Cloudflare Pages Deployment Setup

This project uses Rust WASM, which requires special build configuration for Cloudflare Pages.

## Cloudflare Pages Configuration

When setting up your Cloudflare Pages project, use these settings:

### Build Settings

- **Build command**: `npm run build:cloud`
- **Build output directory**: `dist`
- **Root directory**: `/` (project root)

### Environment Variables

No special environment variables are needed for the build.

## What the build:cloud script does

The `build:cloud` script (`cloud_build.sh`) performs the following:

1. **Installs Rust toolchain** via rustup
2. **Builds the WASM module** using wasm-pack
3. **Builds the Vite app** with TypeScript compilation

## Local Development

For local development, you don't need to use `build:cloud`. Instead:

```bash
# Install dependencies (including wasm-pack)
npm install

# Run dev server (uses pre-built WASM or rebuild with build:wasm if needed)
npm run dev

# Rebuild WASM locally
npm run build:wasm

# Full local build
npm run build
```

## Troubleshooting

### Build fails on Cloudflare Pages

1. Check that `cloud_build.sh` has the executable bit set:
   ```bash
   chmod +x cloud_build.sh
   git add cloud_build.sh
   git commit -m "Make cloud_build.sh executable"
   ```

2. Verify the build command is exactly: `npm run build:cloud`

3. Check build logs for Rust installation errors

### WASM module not found errors

If you get errors about missing WASM modules, rebuild locally:
```bash
npm run build:wasm
```

The generated `rust/fountain-wasm/pkg/` directory should be committed to git for Cloudflare Pages to work properly.
