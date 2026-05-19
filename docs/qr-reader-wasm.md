# QR Reader WASM (`rust/rxing-wasm`)

In-repo Rust → WebAssembly QR-code reader. Replaces the upstream `zxing-wasm`
npm package. Built with `wasm-pack` alongside `fast-qr-wasm` and `fountain-wasm`.

## Why a custom crate

`zxing-wasm` shipped a ~1 MB WASM, required a `postinstall` copy out of
`node_modules`, and exposed many readers the project doesn't use (1D codes,
Data Matrix, Aztec, PDF417, …). This crate strips the QR-decoding subset of
[`rxing`](https://github.com/rxing-core/rxing) down to what `qrcodesecureshare`
actually needs and ships ~450 KB of optimized WASM.

## Layout

```
rust/
├── rxing-vendored/         Trimmed copy of rxing, QR-decoder only.
│   ├── Cargo.toml          No feature flags; minimal deps (regex, encoding_rs,
│   │                        codepage-437, chrono+wasmbind, multimap, num,
│   │                        thiserror, unicode-segmentation, once_cell).
│   ├── src/                rxing source with all non-QR decoders/encoders,
│   │                        client/, helpers, image/svg paths removed.
│   └── tests/              Integration tests + .png/.jpg fixtures.
└── rxing-wasm/             Thin wasm-bindgen wrapper.
    ├── Cargo.toml          cdylib + rlib, depends on path:../rxing-vendored,
    │                        plus js-sys for the JS Array return.
    └── src/lib.rs          Exposes `read_qr_codes_rgba`.
```

`rxing-vendored` keeps the `rxing` crate name so internal `use crate::…` paths
match the upstream tree; the only `Cargo.toml` listing it is
`rust/rxing-wasm/Cargo.toml` via a path dependency.

## Public API

Defined in [`rust/rxing-wasm/src/lib.rs`](../rust/rxing-wasm/src/lib.rs).

```rust
#[wasm_bindgen]
pub fn read_qr_codes_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    try_rotate: bool,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Result<js_sys::Array, JsValue>;
```

Returns a JS `Array` of `Uint8Array`, one entry per detected symbol (empty
array when no QR codes are found). Returns `Err` only for invalid input
(`rgba` length not equal to `width * height * 4`). Callers that need a string
must decode the bytes themselves (e.g. `new TextDecoder().decode(bytes)`).

### Inputs

- **`rgba`** — row-major RGBA bytes, length must equal `width * height * 4`.
  `ImageData` from a 2D canvas can be passed directly.
- **`width` / `height`** — image dimensions in pixels.

### Tunables (parity with zxing-wasm)

| Param | Effect |
| --- | --- |
| `try_harder` | Densifies the finder-pattern scan (rxing's `TryHarder` hint, consumed by `FindFinderPatterns`). With `false`, the row-skip is sized for QR codes up to version 20; with `true`, every third row is scanned. Independent of `max_number_of_symbols`. |
| `try_invert` | If the first pass finds nothing, flips the binarized `BitMatrix` in place and retries. Covers white-on-dark / inverted-reflectance codes. Implemented manually in the wasm wrapper because `QrReader::decode_set_number_with_hints` (the multi-decode entry point) does not consume the `AlsoInverted` hint — that path lives in `MultiFormatReader`, which we deliberately bypass. |
| `try_rotate` | If earlier passes find nothing, rotates the `Luma8LuminanceSource` counter-clockwise 90°, 180°, 270° in turn and retries. **Usually a no-op for clean QR codes** — rxing's QR finder reorders the three concentric finder patterns into a canonical (TL, TR, BL) tri-corner before sampling (see [`detector.rs:139-263`](../rust/rxing-vendored/src/qrcode/cpp_port/detector.rs)) — but worth keeping as a safety net for marginal images where the horizontal finder-pattern scan misses at one orientation but catches it at another. **Zero allocation overhead when no rotation is needed**: `read_inner` only allocates the rotated luma buffer when a previous pass produced no results, and constructs the next rotated source via `rotate_counter_clockwise(&self)` (which borrows, not consumes) before passing the current source into the binarizer, so the fast path with `try_rotate = true` and a hit on the first orientation is identical in cost to `try_rotate = false`. |
| `use_hybrid_binarizer` | When `true`, uses rxing's adaptive `HybridBinarizer` (closest to zxing-wasm's `"LocalAverage"`). When `false`, the faster but less robust `GlobalHistogramBinarizer`. zxing-wasm's `"FixedThreshold"` and `"BoolCast"` variants are not available — rxing doesn't ship them. |
| `max_number_of_symbols` | Cap on results per pass (passed as `count` to `QrReader::decode_set_number_with_hints`). `0` = no cap. `1` lets the multi-decode loop short-circuit on the first valid result and skips the Micro QR / rMQR fallbacks once a QR is found. With `1`, `try_invert` / `try_rotate` retries stop after the first successful pass. |

The retry order when no results are found is:

```
original → (invert) → 90° → (90° invert) → 180° → (180° invert) → 270° → (270° invert)
```

The `(invert)` arms run only when `try_invert = true`. The `90° / 180° / 270°`
arms run only when `try_rotate = true`. The first pass that produces results
wins; remaining passes are skipped.

### Output

A JS `Array` of `Uint8Array`. Each entry is the raw QR byte payload from
rxing's `RXingResult::getRawBytes()` — matching ZXing-C++'s `Barcode::bytes()`
contract. Fountain frames consume this path directly (no UTF-8/Latin-1
roundtrip). Empty array = no QR codes detected.

## JS / TS surface

[`src/utils/rxingWasm.ts`](../src/utils/rxingWasm.ts) wraps the wasm module
with single-flight init (mirrors `fastQrWasm.ts`) and narrows the
`Array<any>` from wasm-bindgen back to `Uint8Array[]`:

```ts
import { readQrCodesFromImageData } from '@/utils/rxingWasm'

const results = await readQrCodesFromImageData(imageData, {
  tryHarder: false,
  tryInvert: false,
  tryRotate: false,
  useHybridBinarizer: true,
  maxNumberOfSymbols: 1,
})
// results is Uint8Array[], possibly empty
```

`RxingReaderOptions` defaults at the TS-wrapper level:

| Option | Default | Notes |
| --- | --- | --- |
| `tryHarder` | `false` | Fountain QR codes are well-formed |
| `tryInvert` | `false` | Sender never inverts |
| `tryRotate` | `true` | Safety net for general-purpose scans; **zero cost when the first orientation hits** (`read_inner` only allocates rotated buffers on miss). The highest-fps consumer (`FountainQRDataScanner`) overrides `false` for an extra speed margin since the sender never produces rotated frames. |
| `useHybridBinarizer` | `true` | Adaptive binarizer for noisy camera output |
| `maxNumberOfSymbols` | `255` | Matches zxing-wasm's default. The worker overrides to `1`. |

The worker's own defaults (in `rxing-qr-scanner.worker.ts`) mirror the
TS-wrapper defaults with `maxNumberOfSymbols: 1`. The
`FountainQRDataScanner` opts out of `tryRotate` via per-consumer
`readerOptions`.

Three consumers wrap the helper:

- [`src/workers/rxing-qr-scanner.worker.ts`](../src/workers/rxing-qr-scanner.worker.ts)
  — message-passing worker (`{type:'scan', imageData, options}` in,
  `{type:'result', data, error?}` out). `data` is `Uint8Array[]` on success
  or `null` when nothing was detected (the `null`-for-empty shape is applied
  at the postMessage boundary only — `readQrCodesFromImageData` itself
  returns `Uint8Array[]`).
- [`src/utils/rxingWorkerUtils.ts`](../src/utils/rxingWorkerUtils.ts) —
  `decodeQRFromImage(file, options?, binary?)` and `decodeQRFromImageData(...)`
  helpers that spin up a worker per call (used for image-upload decode and
  one-shot helpers).
- [`src/hooks/useRxingQRScanner.ts`](../src/hooks/useRxingQRScanner.ts) —
  React hook with a persistent worker, camera lifecycle, debouncing, optional
  low-res mobile capture.

Five components consume the hook: `Scan.tsx`, the fountain receiver
(`TextFountainReceiver`, `FountainQRDataScanner`, `FountainQRFeedbackDisplay`)
and the fountain sender (`FountainQRFeedbackScanner`).

### When to flip `try_harder` / `try_invert` / `try_rotate`

- **Worker defaults** (`tryHarder: false, tryInvert: false, tryRotate: true, useHybridBinarizer: true, maxNumberOfSymbols: 1`)
  cover the common camera-scan case. `tryRotate` is on as a no-cost safety
  net (allocates nothing on first-orientation hits).
- **`tryRotate: false`** on the fountain *data* scanner
  (`FountainQRDataScanner`) — 30 fps continuous scan, sender produces
  upright frames, so saving the rotated-luma allocation on the miss path
  matters. Already wired.
- **`tryHarder: true`** for `Scan.tsx` (uploaded images, general-purpose
  live scan) — has to handle worn, tilted, low-contrast codes. Densifies
  the finder-pattern scan.
- **`tryInvert: true`** when the source might be white-on-dark (e.g. a
  photo of a printed inverted code, or a screenshot from a dark-themed app).

## Architectural note: why we bypass `MultiFormatReader`

The wasm wrapper calls `QrReader::decode_set_number_with_hints` directly
instead of going through `MultiFormatReader` (and previously,
`FilteredImageReader`). Two consequences worth knowing:

1. **The `AlsoInverted` hint is a no-op on this path.** `MultiFormatReader`
   was the consumer of that hint. We replicate its behavior manually via the
   `try_invert` retry loop in `read_inner`.
2. **The `FilteredImageReader` pyramid + morphological-close path is gone.**
   That path was always single-result by construction (it returned on the
   first successful decode) and incompatible with the multi-symbol API. If
   you need the pyramid back for a specific use case, the cleanest way is to
   make `LumImagePyramid` public in `rxing-vendored::filtered_image_reader`
   and inline the layer loop in `read_inner`.

The `PureBarcode` hint is similarly bypassed — `QrReader::internal_decode_with_hints`
routes pure-mode through `DetectPureQR` / `DetectPureMQR` / `DetectPureRMQR`,
which the multi-decode entry point does not call. We do not expose a
`pure_barcode` option today; if it becomes needed, see the "Extending the
crate" section below.

## Build & warmup

```bash
# Builds all three Rust → WASM crates.
npm run build:wasm

# Or just this one:
cd rust/rxing-wasm && npx wasm-pack build --release --target web
```

Artifacts land in `rust/rxing-wasm/pkg/` (gitignored) and are imported
directly by `src/utils/rxingWasm.ts`. There is **no `postinstall` step** and
**no `public/*.wasm`** to keep in sync — the module is bundled like
`fountain-wasm` and `fast-qr-wasm`.

Always invoke `wasm-pack` via `npm/npx` so it resolves to the version pinned
in `package.json` devDependencies (currently `^0.15.0`) — never the
system-wide `cargo install`ed binary.

[`src/utils/wasmWarmup.ts`](../src/utils/wasmWarmup.ts) runs
`ensureRxingWasmInit()` alongside the other two crates at app startup so the
first decode doesn't pay an initialization cost.

The cloud build at `cloud_build.sh` mirrors `npm run build:wasm` — add new
crates there too if the list grows.

## Tests

Native cargo tests live in `rust/rxing-vendored/tests/qr_decode.rs` and load
fixtures from `rust/rxing-vendored/tests/fixtures/`. Run from the crate
directory:

```bash
cd rust/rxing-vendored && cargo test
```

The test file covers two paths:

1. **Legacy `MultiFormatReader` path** (`decode_inner`) — exercises
   `try_harder` × `try_invert` × `use_hybrid_binarizer` over every fixture.
   These tests document upstream rxing behavior.
2. **wasm-wrapper-equivalent path** (`decode_with_retry`) — mirrors
   `read_inner` from `rxing-wasm/src/lib.rs`: `QrReader::decode_set_number_with_hints`
   plus the manual BitMatrix flip (`try_invert`) and `Luma8LuminanceSource::rotate_counter_clockwise()`
   (`try_rotate`) retries. Tests:
   - `inverted_qr_sample_requires_try_invert` — pixel-invert `qr_sample.png`,
     verify it does *not* decode without `try_invert` and *does* with it.
     This is the regression test for the manual-flip code path.
   - `rotated_qr_sample_decodes_without_try_rotate` — rotate 90° CW, verify
     it decodes natively. Pins the "rxing detector is rotation-invariant"
     guarantee that makes `try_rotate` rarely useful in practice.
   - `rotated_and_inverted_qr_sample_requires_try_invert` — compose both;
     verifies the (rotation × inversion) outer product in the retry loop
     finds the right combination.

Current fixtures:

| File | Expected `text` | Exercises |
| --- | --- | --- |
| `qr_sample.png` | `jfghjghjghfkghjkghj` | Baseline byte-mode QR. Also the source for the synthetic invert/rotate variants. |
| `qr_code_complex.png` | `https://qr-code-styling.com` | Stylized QR (rounded modules, gradient eyes). |
| `qr_zoo.jpg` | `https://zoo.sandiegozoo.org/2024-sdmag-pandas` | Real phone photo of white-on-dark-green QR — only decodes with `try_harder = true` (the legacy `FilteredImageReader` pyramid path). |
| `fountain_binary_real.png` | binary fountain chunk | Real fountain byte-mode QR; asserts binary output starts with `ff fd`. |

Add a new fixture by dropping the file in `tests/fixtures/` and adding a
`#[test]` that asserts the exact decoded text — the harness is one helper
(`load_image_as_rgba`) wide.

## Extending the crate

- **A new tunable** — thread a `bool` / `u32` through `read_qr_codes_rgba`'s
  parameter list, plumb it into `read_inner`, then surface it in
  `RxingReaderOptions` in `src/utils/rxingWasm.ts`. Keep the wasm signature
  flat; no struct args (`wasm-bindgen`'s struct passing forces extra
  allocations per call).
- **Additional formats** — `rxing-vendored` is QR-only by design. The
  `multi_format_reader.rs` / `multi_use_multi_format_reader.rs` files were
  rewritten to remove non-QR match arms; re-adding a format means restoring
  its source under `rust/rxing-vendored/src/`, wiring the match arm back,
  and un-trimming Cargo deps as needed. For one-off non-QR work, prefer
  adding a separate small crate over re-fattening `rxing-vendored`.
- **Out-of-band side metadata** — `RXingResult` carries `IS_INVERTED`,
  `FILTERED_CLOSED`, `FILTERED_RESOLUTION`, etc. Extract via
  `result.getRXingResultMetadata().get(&type)` and return as a richer JS
  shape if needed. The current wrapper deliberately returns only raw bytes
  (`getRawBytes()`) — see the "byte return optimization" trade-off in the
  retry-loop design.

## Trimming notes (gotchas if re-vendoring rxing)

If a future rxing upgrade requires re-vendoring, the original trim removed:

- `aztec/`, `datamatrix/`, `maxicode/`, `oned/`, `pdf417/`, `multi/`, `client/`
- `helpers.rs` (file/image/svg helpers we don't use)
- `buffered_image_*`, `svg_*`, `planar_yuv_*`, `rgb_luminance_*` sources
- `encode_hints.rs`, `multi_format_writer.rs`, `writer.rs`,
  `qrcode/encoder/`, `qrcode/qr_code_writer.rs`
- `crates/` (1D proc-derive workspace member)
- All `*TestCase.rs` / `*_test_case.rs` files and `tests/` / `benches/` /
  `test_resources/`

The two source-level traps to watch for after a re-vendor — both caused the
"always returns no result" symptom during the original trim:

1. `multi_format_reader.rs` / `multi_use_multi_format_reader.rs` gate every
   format arm with `#[cfg(feature = "qrcode")]`. With no features in the
   trimmed `Cargo.toml`, those arms compile out and the reader silently
   returns `UNSUPPORTED_OPERATION`. The trimmed copies in this repo are
   hand-written QR-only replacements; if upstream rxing changes the dispatch
   surface, port the replacements forward — don't just delete the gates
   from upstream files.
2. `qrcode/cpp_port/mod.rs` similarly gates `QrReader` behind
   `feature = "decoders"`. Make sure the un-gated re-export survives the
   re-vendor — and that `QrReader::decode_set_number_with_hints` stays
   `pub`, since the wasm wrapper calls it directly.

The cargo test suite in `rxing-vendored/tests/qr_decode.rs` is the
load-bearing check that the vendored copy actually decodes — keep all eight
tests green before pushing.
