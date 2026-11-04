# Agent instructions

## Compatibility

- No backward compatibility at all for any changes.

## Checks to run

- After JavaScript or TypeScript changes, run `bun run lint` and then
  `bunx tsc -b`, and fix what they report. `bun run format` applies Biome's
  formatting and safe fixes.
- After Rust changes under `wasm/**`, run `bun run clippy` and `bun run test`.
- for codex only no `cargo fmt` because when it does git diff, it gets stuck after cargo fmt.

## WebAssembly

- The app's own module is `wasm/fountain`, the LT fountain encoder, decoder and
  CRC32. It is not a package: `bun run build:wasm` builds it with
  `wasm-pack build --release --target web --no-pack` into `wasm/fountain/pkg/`,
  which is gitignored, and `src/utils/fountainCodeWasm.ts` and
  `src/utils/checksum.ts` import the glue from there by path. `bun run build`
  builds it first. The crate keeps its own `Cargo.lock` and
  `rust-toolchain.toml` (stable, `wasm32-unknown-unknown`), which rustup reads
  wherever the app is built.
- Initialise every wasm-bindgen module with its binary's URL from a Vite `?url`
  import (`init({ module_or_path: url })`), never with the glue's default
  `new URL(..., import.meta.url)` lookup.
- The QR reader wasm is published from
  `https://github.com/andrewtheguy/rxing-reader` as `@andrewtheguy/rxing-wasm`,
  and the QR generator wasm from `https://github.com/andrewtheguy/fast_qr` as
  `@andrewtheguy/fast-qr-wasm`. Both are consumed as release tarball URLs in
  `package.json`; a `file:` dependency must never be committed.
- Always invoke wasm-pack through `bun run` / `bunx` so it resolves to the
  version pinned exactly in `package.json` devDependencies, never a
  system-wide `cargo install`ed binary. It is in `trustedDependencies` so that
  `bun install` runs the postinstall that downloads its binary.

## Tools

- For one-off Python scripts, always run them with `uv`.
