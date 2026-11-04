# Cloudflare Pages Deployment Setup

The app ships one WebAssembly module built from this repository,
`wasm/fountain`, so a Cloudflare Pages build needs a Rust toolchain. The QR
reader (`@andrewtheguy/rxing-wasm`) and QR generator (`@andrewtheguy/fast-qr-wasm`)
are prebuilt release tarballs that `bun install` fetches like any other
dependency.

## Cloudflare Pages Configuration

### Build Settings

- **Build command**: `bun run build:cloud`
- **Build output directory**: `dist`
- **Root directory**: `/` (project root)

Pages installs dependencies with Bun because the repository has a `bun.lock`.
Set the `BUN_VERSION` environment variable to the version in `packageManager`
in `package.json` so the build uses the same Bun as local development.

## What `build:cloud` does

`cloud_build.sh`:

1. Installs rustup, with no default toolchain.
2. Runs `rustup toolchain install` in `wasm/fountain`, which installs the
   toolchain and the `wasm32-unknown-unknown` target that
   `wasm/fountain/rust-toolchain.toml` pins.
3. Runs `bun run build`: the wasm module through the pinned `wasm-pack`
   devDependency, then `tsc -b` and `vite build`.

## Local Development

```bash
bun install
bun run build:wasm   # once, and after every change under wasm/
bun run dev
bun run build        # the full production build
```

## Troubleshooting

### WASM module not found

`wasm/fountain/pkg/` is a build output and is not committed. Run
`bun run build:wasm` to create it.

### `wasm-pack` has no binary

The `wasm-pack` package downloads its binary in a postinstall script, which Bun
runs only because `package.json` lists it in `trustedDependencies`. Reinstall
with `bun install` if the binary is missing.
