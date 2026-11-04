# QR Reader WASM

The QR reader is maintained outside this repository in
[andrewtheguy/rxing-reader](https://github.com/andrewtheguy/rxing-reader). That
repository owns the Rust workspace, builds the wasm package, and publishes
`@andrewtheguy/rxing-wasm` as a tarball on its GitHub releases.

## Package Layout

The external repository contains two Cargo workspace members:

- `rxing-vendored`: trimmed QR-reading fork of `rxing`.
- `rxing-wasm`: `wasm-bindgen` wrapper that exposes `read_qr_codes_rgba`.

This app imports the published package in
[`src/utils/rxingWasm.ts`](../src/utils/rxingWasm.ts):

```ts
import initRxingWasm, { read_qr_codes_rgba } from '@andrewtheguy/rxing-wasm'
import rxingWasmUrl from '@andrewtheguy/rxing-wasm/rxing_wasm_bg.wasm?url'
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

The GitHub Actions workflow in `rxing-reader` attaches
`andrewtheguy-rxing-wasm-<version>.tgz` to a release. This repository depends on
that release's tarball URL in `package.json`; point it at the new release with
`bun add` after publishing a new reader version.

## Local App Build

`bun run build:wasm` in this repository only builds the in-repo
`wasm/fountain` crate. The QR reader (`@andrewtheguy/rxing-wasm`) and QR
generator (`@andrewtheguy/fast-qr-wasm`) are installed like any other
dependencies — both are pinned to GitHub release tarballs in `package.json`.
