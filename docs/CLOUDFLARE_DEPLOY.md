# Cloudflare Pages Deployment Setup

This project uses Rust WASM, which requires special build configuration for Cloudflare Pages.

## Cloudflare Pages Configuration

When setting up your Cloudflare Pages project, use these settings:

### Build Settings

- **Build command**: `npm run build:cloud`
- **Build output directory**: `dist`
- **Root directory**: `/` (project root)

### Environment Variables

Configure npm auth for GitHub Packages so Cloudflare can install
`@andrewtheguy/rxing-wasm`. The repository `.npmrc` reads:

- `NODE_AUTH_TOKEN`: a token that can read packages from `andrewtheguy`.

## What the build:cloud script does

The `build:cloud` script (`cloud_build.sh`) performs the following:

1. **Installs Rust toolchain** via rustup
2. **Builds the in-repo WASM modules** using wasm-pack
3. **Builds the Vite app** with TypeScript compilation

## Local Development

For local development, you don't need to use `build:cloud`. Instead:

```bash
# Install dependencies, including the published QR reader package
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

The generated `rust/fountain-wasm/pkg/` directory should be committed to git
for Cloudflare Pages to work properly. The QR reader (`@andrewtheguy/rxing-wasm`)
and QR generator (`@andrewtheguy/fast-qr-wasm`) packages are installed from
GitHub release tarballs instead of being built inside this repository.
