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
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Result<js_sys::Array, JsValue>;
```

Rotation is handled natively by rxing's finder-pattern canonical reordering
(`detector.rs:139-263`); a previously-exposed `try_rotate` flag (90°/180°/270°
re-scan retries) was removed after an empirical probe showed it produced zero
additional decodes on every fixture in the test suite — the close-pass under
`try_harder` is what rescues the visually-rotated fixtures (`qr_code_complex_rotated.jpg`,
`qr_sample_rotated_speckled.png`), not the rotation retry itself.

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
| `try_harder` | Three things bundled together: (1) densifies the finder-pattern scan via rxing's `TryHarder` hint (row-skip drops from `(3·height)/(4·97)` to `3`); (2) on miss, applies a 3×3 morphological close (`BinaryBitmap::close()` — dilate then erode) to the binarized matrix and retries; (3) on further miss, walks a downscale pyramid (`downscale_luma_buffer`, factor 3, threshold 500 px) trying each layer with and without the close pass. Equivalent to zxing-wasm's `tryHarder + tryDownscale + tryDenoise`. Independent of `max_number_of_symbols`. |
| `try_invert` | If the first pass finds nothing, flips the binarized `BitMatrix` in place and retries. Covers white-on-dark / inverted-reflectance codes. Implemented manually in the wasm wrapper because `QrReader::decode_set_number_with_hints` (the multi-decode entry point) does not consume the `AlsoInverted` hint — that path lives in `MultiFormatReader`, which we deliberately bypass. |
| `use_hybrid_binarizer` | When `true`, uses rxing's adaptive `HybridBinarizer` (closest to zxing-wasm's `"LocalAverage"`). When `false`, the faster but less robust `GlobalHistogramBinarizer`. zxing-wasm's `"FixedThreshold"` and `"BoolCast"` variants are not available — rxing doesn't ship them. |
| `max_number_of_symbols` | Cap on results per pass (passed as `count` to `QrReader::decode_set_number_with_hints`). `0` = no cap. `1` lets the multi-decode loop short-circuit on the first valid result and skips the Micro QR / rMQR fallbacks once a QR is found. With `1`, `try_invert` retry stops after the first successful pass. |

The retry order when no results are found is:

```
original → (invert)
```

The `(invert)` arm runs only when `try_invert = true`. With `try_harder = true`,
each resolution layer in the downscale pyramid additionally runs a close-pass
variant: `original → (invert) → original-closed → (invert-closed) → downscaled
→ … → downscaled-closed`. The first pass that produces results wins; remaining
passes are skipped.

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
| `useHybridBinarizer` | `true` | Adaptive binarizer for noisy camera output |
| `maxNumberOfSymbols` | `255` | Matches zxing-wasm's default. The worker overrides to `1`. |

The worker's own defaults (in `rxing-qr-scanner.worker.ts`) mirror the
TS-wrapper defaults with `maxNumberOfSymbols: 1`.

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

### When to flip `try_harder` / `try_invert`

- **Worker defaults** (`tryHarder: false, tryInvert: false, useHybridBinarizer: true, maxNumberOfSymbols: 1`)
  cover the common camera-scan case. Rotation is handled natively by
  rxing's finder-pattern canonical reordering — no rotation-retry flag.
- **`tryHarder: true`** for `Scan.tsx` (uploaded images, general-purpose
  live scan) — has to handle worn, tilted, low-contrast codes. Densifies
  the finder-pattern scan plus runs the morphological close-pass and
  downscale-pyramid retries.
- **`tryInvert: true`** when the source might be white-on-dark (e.g. a
  photo of a printed inverted code, or a screenshot from a dark-themed app).

## Architectural note: the only decode path

`QrReader::decode_set_number_with_hints` is the single decode entry point.
The legacy `Reader` / `ImmutableReader` traits, `MultiFormatReader`,
`MultiUseMultiFormatReader`, and `FilteredImageReader` have all been
removed from `rxing-vendored`, along with the `AlsoInverted` and
`PureBarcode` `DecodeHints` (no consumer left) and the `DetectPureQR` /
`DetectPureMQR` / `DetectPureRMQR` shortcuts (only used by the removed
`internal_decode_with_hints` pure-barcode dispatch).

The decode strategies the legacy wrappers used to bundle (`tryInvert`,
`tryDownscale`, `tryDenoise`/morphological close) are now implemented in
`read_inner` (the wasm wrapper's strategy orchestrator). The underlying
algorithms live in `rxing-vendored` as flat utilities — no `Reader`-trait
coupling, no OOP wrapper:

- **`BinaryBitmap::close()`** — 3×3 morphological close (dilate → erode) on
  the cached BitMatrix.
- **`downscale_luma_buffer(src, w, h, factor)`** — box-average pyramid
  layer step.

Practical consequences:

1. **`try_invert` is implemented in `read_inner`.** The legacy
   `MultiFormatReader::decode_internal` `AlsoInverted` handler is gone;
   the retry loop's in-place `BitMatrix::flip_self()` is the only
   inversion path.
2. **`try_harder` bundles three retry strategies in `read_inner`:**
   `TryHarder` hint → finder-pattern densification; then morphological
   close; then a downscale pyramid. This is what restores the
   real-world-photo capability the removed `FilteredImageReader` used to
   provide (regression-tested via `qr_zoo_jpg_requires_try_harder_and_try_invert`,
   `qr_code_complex_rotated_jpg_requires_try_harder`, and
   `qr_sample_rotated_speckled_png_requires_try_harder`).
3. **No `pure_barcode` option.** If a caller has a clean axis-aligned QR
   and wants the fast `DetectPureQR` path, see "Extending the crate" below
   — restoring that path means reintroducing `DetectPureQR` in
   `detector.rs` and a `pure_barcode` flag in `read_inner`.

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

The test harness mirrors the wasm wrapper's only decode path
(`QrReader::decode_set_number_with_hints` + the manual BitMatrix flip for
`try_invert`). `decode_inner` is the equivalent of `rxing_wasm::read_inner`
specialized to a single symbol; `decode_combo` runs it over an
`ALL_COMBOS` triple. Per-fixture tests assert which `(try_harder,
try_invert, use_hybrid_binarizer)` combos succeed — see the fixture table
below for the discriminating option per fixture.

Two additional in-memory transform tests cover rotation, which no on-disk
fixture exercises:

- `rotated_qr_sample_decodes_natively` — rotates `qr_sample.png` 90° CW
  in-memory and decodes via `decode_combo`. Pins rxing's QR-detector
  rotation invariance.
- `rotated_and_inverted_qr_sample_requires_try_invert` — composes rotation
  + inversion, verifies the manual-flip path still works on a rotated
  source.

Current fixtures:

| File | Expected `text` | Exercises | Discriminating option |
| --- | --- | --- | --- |
| `qr_sample.png` | `jfghjghjghfkghjkghj` | Baseline byte-mode QR. Also the source for the two synthetic `qr_sample_*` variants. | none — decodes in all 8 combos |
| `qr_code_complex.png` | `https://qr-code-styling.com` | Stylized QR (rounded modules, gradient eyes). | none — decodes in all 8 combos |
| `qr_sample_inverted.png` | `jfghjghjghfkghjkghj` | Pixel-inverted (`magick … -negate`) copy of `qr_sample.png`. The `AlsoInverted` hint isn't consumed by `QrReader`'s multi-decode path, so the only way to decode is to flip the BitMatrix in the retry loop. | **`try_invert` only** — independent of `try_harder` |
| `qr_sample_small_in_canvas.png` | `jfghjghjghfkghjkghj` | `qr_sample.png` resized to 80×80 and pasted into a 1600×1600 white canvas. `FindFinderPatterns` picks `skip ≈ 12` by default; the shrunken finder modules (~3 px tall) are walked past unless `try_harder = true` densifies the scan to `skip = 3`. | **`try_harder` only** — independent of `try_invert` |
| `qr_code_complex_rotated.jpg` | `https://nc.cesdk12.org/ncsd/…` | Real 183×210 phone photo of a rotated QR encoding a longer URL payload. Below the pyramid downscale threshold, so the **close-pass** branch of `try_harder` (`bitmap.close()`) is what surfaces the finders. | **`try_harder` only** |
| `qr_sample_rotated_speckled.png` | `jfghjghjghfkghjkghj` | Synthetic 373×373 analog of `qr_code_complex_rotated.jpg`: `qr_sample.png` nearest-neighbor rotated 17° + sparse white-salt mask (20% density). Rotation aliasing + 1-pixel holes inside finder bars defeat the original-resolution scan; the **close-pass** branch of `try_harder` fills the holes. | **`try_harder` only** |
| `qr_zoo.jpg` | `https://zoo.sandiegozoo.org/2024-sdmag-pandas` | Real 2258×1344 phone photo of a white-on-dark-green QR. Needs the pyramid **downscale** branch of `try_harder` to surface finders + `try_invert` to read the inverted reflectance. | **`try_harder` AND `try_invert`** |
| `fountain_binary_real.png` | binary fountain chunk | Real fountain byte-mode QR; asserts binary output starts with `ff fd`. | none — decodes in all 8 combos |

Add a new fixture by dropping the file in `tests/fixtures/` and adding a
`#[test]` that asserts the exact decoded text and the combos required —
the harness is two helpers (`load_image_as_rgba`, `decode_combo`) wide, and
`ALL_COMBOS` provides the (try_harder, try_invert, use_hybrid_binarizer)
Cartesian product. Two `#[ignore]`d helper tests live in the same file:
`probe_fixture_requirements` (prints which combos decode each fixture, for
when adding a new fixture) and the regeneration of the synthetic
`qr_sample_*` variants is in
[`tests/fixtures/regen_synthetic.sh`](../rust/rxing-vendored/tests/fixtures/regen_synthetic.sh)
(requires ImageMagick v7).

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
