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
│   └── src/                rxing source with all non-QR decoders/encoders,
│                            client/, helpers, image/svg paths removed.
└── rxing-wasm/             Thin wasm-bindgen wrapper.
    ├── Cargo.toml          cdylib + rlib, depends on path:../rxing-vendored.
    ├── src/lib.rs          Exposes `decode_qr_rgba` + `DecodedQr`.
    └── tests/fixtures/     Round-trip fixtures (.png + .jpg) used by
                             `cargo test`.
```

`rxing-vendored` keeps the `rxing` crate name so internal `use crate::…` paths
match the upstream tree; the only `Cargo.toml` listing it is
`rust/rxing-wasm/Cargo.toml` via a path dependency.

## Public API

Defined in [`rust/rxing-wasm/src/lib.rs`](../rust/rxing-wasm/src/lib.rs).

```rust
#[wasm_bindgen]
pub struct DecodedQr { /* text, bytes via getters */ }

#[wasm_bindgen]
pub fn decode_qr_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
) -> Result<Option<DecodedQr>, JsValue>;
```

### Inputs

- **`rgba`** — row-major RGBA bytes, length must equal `width * height * 4`
  (mismatched length is the only condition that returns a `JsValue` error).
  ImageData from a 2D canvas can be passed directly.
- **`width` / `height`** — image dimensions in pixels.

### Tunables

| Param | Effect |
| --- | --- |
| `try_harder` | Routes through rxing's `FilteredImageReader`: walks a downscale pyramid + a morphological-close pass before each decode. Required for tough photos (perspective, low contrast, color QR on coloured background). Plain `MultiFormatReader` is used when `false`. |
| `try_invert` | Sets `DecodeHints::AlsoInverted`; rxing retries with the bitmap flipped — covers white-on-dark or otherwise inverted QRs. |
| `use_hybrid_binarizer` | When `try_harder = false`, picks between rxing's adaptive `HybridBinarizer` (`true`, default, more accurate) and the faster `GlobalHistogramBinarizer` (`false`). When `try_harder = true` the binarizer choice is overridden — `FilteredImageReader` always pairs `HybridBinarizer` with its pyramid layers. |

The original `zxing-wasm` `tryRotate` flag has no equivalent: rxing's QR
finder-pattern detector is rotation-invariant. `tryDownscale` and `tryDenoise`
collapse into `try_harder = true`. `maxNumberOfSymbols` is always 1.

### Output

`Some(DecodedQr)` on a successful decode. `None` on `NotFound` /
`FormatException` (the common "no QR in this frame" case). The two fields:

- `text`: rxing's `RXingResult::getText()`. Lossless UTF-8 for text-mode QRs;
  Latin-1-style passthrough for byte-mode QRs.
- `bytes`: rxing's raw decoded content bytes, matching ZXing-C++'s
  `Barcode::bytes()` contract. Fountain frames use this path.

`DecodedQr` is a wasm-bindgen handle; consumers should call `free()` after
copying fields out. The JS wrapper already does this — see below.

## JS / TS surface

[`src/utils/rxingWasm.ts`](../src/utils/rxingWasm.ts) wraps the wasm module with
single-flight init (mirrors `fastQrWasm.ts`) and copies the handle's fields out
before freeing it:

```ts
import { decodeQrFromImageData } from '@/utils/rxingWasm'

const result = await decodeQrFromImageData(imageData, {
  tryHarder: true,
  tryInvert: true,
  useHybridBinarizer: true,
})
// result is { text, bytes } | null
```

Three consumers wrap this:

- [`src/workers/rxing-qr-scanner.worker.ts`](../src/workers/rxing-qr-scanner.worker.ts)
  — message-passing worker (`{type:'scan', imageData, binary, options}` in,
  `{type:'result', data, error?}` out). `data` is `(string | Uint8Array)[]`
  with a single element on success, or `null` on miss.
- [`src/utils/rxingWorkerUtils.ts`](../src/utils/rxingWorkerUtils.ts) —
  `decodeQRFromImage(file, options?, binary?)` and `decodeQRFromImageData(...)`
  helpers that spin up a worker per call (used for image-upload decode and one-
  shot helpers).
- [`src/hooks/useRxingQRScanner.ts`](../src/hooks/useRxingQRScanner.ts) —
  React hook with a persistent worker, camera lifecycle, debouncing, optional
  low-res mobile capture.

Five components consume the hook: `Scan.tsx`, the fountain receiver
(`TextFountainReceiver`, `FountainQRDataScanner`, `FountainQRFeedbackDisplay`)
and the fountain sender (`FountainQRFeedbackScanner`).

### When to flip `try_harder`

- **`true`** for `Scan.tsx` (uploaded images, general-purpose live scan) — has
  to handle worn, tilted, low-contrast, coloured codes.
- **`false`** for fountain data/feedback scanners — they run at 30 fps on
  generated QR codes from the partner device, so `FilteredImageReader`'s
  pyramid is wasted budget there.

The worker's defaults are `tryHarder: false, tryInvert: false,
useHybridBinarizer: true` to keep fountain scanning fast. Callers override per
use case.

## Build & warmup

```bash
# Builds all three Rust → WASM crates.
npm run build:wasm

# Or just this one:
cd rust/rxing-wasm && wasm-pack build --release --target web
```

Artifacts land in `rust/rxing-wasm/pkg/` (gitignored) and are imported directly
by `src/utils/rxingWasm.ts`. There is **no `postinstall` step** and **no
`public/*.wasm`** to keep in sync — the module is bundled like
`fountain-wasm` and `fast-qr-wasm`.

[`src/utils/wasmWarmup.ts`](../src/utils/wasmWarmup.ts) runs
`ensureRxingWasmInit()` alongside the other two crates at app startup so the
first decode doesn't pay an initialization cost.

The cloud build at `cloud_build.sh` mirrors `npm run build:wasm` — add new
crates there too if the list grows.

## Tests

Native cargo tests live in `rust/rxing-wasm/src/lib.rs` and load fixtures from
`rust/rxing-wasm/tests/fixtures/`. Run from the crate directory:

```bash
cargo test --release
```

Current fixtures:

| File | Expected `text` | Exercises |
| --- | --- | --- |
| `qr_sample.png` | `jfghjghjghfkghjkghj` | Baseline byte-mode QR; also asserts `bytes` matches. |
| `qr_code_complex.png` | `https://qr-code-styling.com` | Stylized QR (rounded modules, gradient eyes). |
| `qr_zoo.jpg` | `https://zoo.sandiegozoo.org/2024-sdmag-pandas` | Real phone photo of a white-on-dark-green QR — only decodes with `try_harder = true` (the `FilteredImageReader` pyramid). |
| `fountain_binary_real.png` | binary fountain chunk | Real fountain byte-mode QR; asserts binary output starts with `ff fd` rather than UTF-8-expanded text bytes. |

Add a new fixture by dropping the file in `tests/fixtures/` and adding a `#[test]`
that asserts the exact decoded text — the harness is one helper
(`load_image_as_rgba`) wide.

## Extending the crate

- **A new tunable** — thread a `bool`/`u32` through `decode_qr_rgba`'s
  parameter list, set the matching `DecodeHints` field in `decode_inner`, then
  surface it in `RxingReaderOptions` in `src/utils/rxingWasm.ts`. Keep the wasm
  signature flat; no struct args.
- **Additional formats** — `rxing-vendored` is QR-only by design. The
  `multi_format_reader.rs` / `multi_use_multi_format_reader.rs` files were
  rewritten to remove non-QR match arms; re-adding a format means restoring
  its source under `rust/rxing-vendored/src/`, wiring the match arm back, and
  un-trimming Cargo deps as needed. For one-off non-QR work, prefer adding a
  separate small crate over re-fattening `rxing-vendored`.
- **Out-of-band side metadata** — `RXingResult` carries `IS_INVERTED`,
  `FILTERED_CLOSED`, `FILTERED_RESOLUTION`, etc. Extract via
  `result.getRXingResultMetadata().get(&type)` and expose as additional
  `DecodedQr` fields if needed.

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
   trimmed `Cargo.toml`, those arms compile out and the reader silently returns
   `UNSUPPORTED_OPERATION`. The trimmed copies in this repo are hand-written
   QR-only replacements; if upstream rxing changes the dispatch surface, port
   the replacements forward — don't just delete the gates from upstream files.
2. `qrcode/cpp_port/mod.rs` similarly gates `QrReader` behind `feature =
   "decoders"`. Make sure the un-gated re-export survives the re-vendor.

The cargo test suite in `rxing-wasm` is the load-bearing check that the
vendored copy actually decodes — keep it green before pushing.
