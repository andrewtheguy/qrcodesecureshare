# QR Reader WASM

The QR reader is maintained outside this repository in
[andrewtheguy/rxing-reader](https://github.com/andrewtheguy/rxing-reader). That
repository owns the Rust workspace, builds the wasm package, and publishes
`@andrewtheguy/rxing-wasm` to GitHub Packages.

## Package Layout

The external repository contains two Cargo workspace members:

- `rxing-vendored`: trimmed QR-reading fork of `rxing`.
- `rxing-wasm`: `wasm-bindgen` wrapper that exposes `read_qr_codes_rgba`.

This app imports the published package in
[`src/utils/rxingWasm.ts`](../src/utils/rxingWasm.ts):

```ts
import initRxingWasm, { read_qr_codes_rgba } from '@andrewtheguy/rxing-wasm'
```

## App API

`src/utils/rxingWasm.ts` keeps the app-facing API stable:

- `ensureRxingWasmInit()`
- `readQrCodesFromRgba(rgba, width, height, options)`
- `readQrCodesFromImageData(imageData, options)`
- `RxingReaderOptions`

The wasm function returns a JS array of `Uint8Array`, one entry per detected
symbol. Callers that need text decode those bytes themselves.

## Build And Release

Build and test the reader in the external repository:

```sh
cd /home/debian/codes/rxing-reader
npm install
npm run build:wasm
npm run clippy
npm test
```

The GitHub Actions workflow in `rxing-reader` publishes
`@andrewtheguy/rxing-wasm` on version tags. This repository consumes a pinned
semver in `package.json`; update that dependency after publishing a new reader
version.

## Local App Build

`npm run build:wasm` in this repository only builds the in-repo
`fountain-wasm` crate. The QR reader (`@andrewtheguy/rxing-wasm`) and QR
generator (`@andrewtheguy/fast-qr-wasm`) are installed like any other npm
dependencies — both are pinned to GitHub release tarballs in `package.json`.
