use std::collections::HashSet;
use std::path::PathBuf;

use image::ImageReader;
use rxing::{
    BarcodeFormat, Binarizer, BinaryBitmap, DecodeHints, Luma8LuminanceSource,
    common::{GlobalHistogramBinarizer, HybridBinarizer},
    downscale_luma_buffer,
    qrcode::cpp_port::QrReader,
};

// Mirror rxing-wasm's pyramid + close thresholds (`tryHarder` capability).
const PYRAMID_DOWNSCALE_THRESHOLD: u32 = 500;
const PYRAMID_DOWNSCALE_FACTOR: u32 = 3;

fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "Image dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "rgba length {} != width*height*4 ({})",
            rgba.len(),
            expected
        ));
    }
    Ok(rgba
        .chunks_exact(4)
        .map(|p| {
            // ITU-R BT.601 luma weights (rounded).
            let r = p[0] as u32;
            let g = p[1] as u32;
            let b = p[2] as u32;
            ((r * 299 + g * 587 + b * 114 + 500) / 1000) as u8
        })
        .collect())
}

/// Decode once on `bitmap`; on miss, when `try_invert`, flip the BitMatrix
/// in place and decode again. Mirrors `rxing_wasm::read_inner`'s inversion
/// path.
fn decode_with_optional_invert<B: Binarizer>(
    bitmap: &mut BinaryBitmap<B>,
    hints: &DecodeHints,
    try_invert: bool,
) -> Option<Vec<u8>> {
    if let Ok(mut r) = QrReader.decode_set_number_with_hints(bitmap, hints, 1)
        && let Some(first) = r.pop()
    {
        return Some(first.getRawBytes().to_vec());
    }
    if try_invert
        && let Ok(matrix) = bitmap.get_black_matrix_mut()
    {
        matrix.flip_self();
        if let Ok(mut r) = QrReader.decode_set_number_with_hints(bitmap, hints, 1)
            && let Some(first) = r.pop()
        {
            return Some(first.getRawBytes().to_vec());
        }
    }
    None
}

/// One resolution × close pass: build a fresh BinaryBitmap from `source`
/// (consumed), apply optional morphological close, then decode with optional
/// invert retry. Returns the decoded payload or `None`.
fn decode_one_layer(
    source: Luma8LuminanceSource,
    hints: &DecodeHints,
    use_hybrid_binarizer: bool,
    try_invert: bool,
    close: bool,
) -> Option<Vec<u8>> {
    if use_hybrid_binarizer {
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        if close && bitmap.close().is_err() {
            return None;
        }
        decode_with_optional_invert(&mut bitmap, hints, try_invert)
    } else {
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        if close && bitmap.close().is_err() {
            return None;
        }
        decode_with_optional_invert(&mut bitmap, hints, try_invert)
    }
}

/// Single-symbol decode that mirrors `rxing_wasm::read_inner` exactly:
/// `QrReader::decode_set_number_with_hints` plus the manual BitMatrix flip
/// for `try_invert` and the pyramid + morphological-close pre-pass for
/// `try_harder`.
fn decode_inner(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
) -> Option<Vec<u8>> {
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        TryHarder: Some(try_harder),
        ..DecodeHints::default()
    };

    // Fast path (no try_harder): original resolution only, no close pass.
    if !try_harder {
        let source = Luma8LuminanceSource::new(luma, width, height);
        return decode_one_layer(source, &hints, use_hybrid_binarizer, try_invert, false);
    }

    // try_harder path: original resolution, then close, then downscale +
    // repeat. Matches the rxing-wasm wrapper.
    let mut cur_luma = luma;
    let mut cur_w = width;
    let mut cur_h = height;
    loop {
        for &close in &[false, true] {
            let source = Luma8LuminanceSource::new(cur_luma.clone(), cur_w, cur_h);
            if let Some(bytes) =
                decode_one_layer(source, &hints, use_hybrid_binarizer, try_invert, close)
            {
                return Some(bytes);
            }
        }
        if cur_w.max(cur_h) <= PYRAMID_DOWNSCALE_THRESHOLD
            || cur_w.min(cur_h) < PYRAMID_DOWNSCALE_FACTOR
        {
            return None;
        }
        let (next_luma, next_w, next_h) =
            downscale_luma_buffer(&cur_luma, cur_w, cur_h, PYRAMID_DOWNSCALE_FACTOR);
        cur_luma = next_luma;
        cur_w = next_w;
        cur_h = next_h;
    }
}

fn load_image_as_rgba(relative_path: &str) -> (Vec<u8>, u32, u32) {
    let mut full = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    full.push(relative_path);
    let img = ImageReader::open(&full)
        .expect("open image")
        .with_guessed_format()
        .expect("guess image format")
        .decode()
        .expect("decode image")
        .into_rgba8();
    let (w, h) = (img.width(), img.height());
    (img.into_raw(), w, h)
}

// The full Cartesian product of (try_harder, try_invert, use_hybrid_binarizer).
// All three flags compose freely on the only remaining decode path
// (`QrReader::decode_set_number_with_hints` + the manual BitMatrix flip for
// inversion); each affects an orthogonal stage of the pipeline.
const ALL_COMBOS: [(bool, bool, bool); 8] = [
    (false, false, false),
    (false, false, true),
    (false, true, false),
    (false, true, true),
    (true, false, false),
    (true, false, true),
    (true, true, false),
    (true, true, true),
];

fn decode_combo(
    rgba: &[u8],
    w: u32,
    h: u32,
    (try_harder, try_invert, use_hybrid_binarizer): (bool, bool, bool),
) -> Option<Vec<u8>> {
    let luma = rgba_to_luma(rgba, w, h).expect("luma");
    decode_inner(luma, w, h, try_harder, try_invert, use_hybrid_binarizer)
}

#[test]
fn decodes_qr_sample_png_in_every_combination() {
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    for combo in ALL_COMBOS {
        let bytes = decode_combo(&rgba, w, h, combo)
            .unwrap_or_else(|| panic!("qr_sample.png failed to decode for combo={:?}", combo));
        assert_eq!(
            bytes.as_slice(),
            b"jfghjghjghfkghjkghj",
            "unexpected bytes for combo={:?}",
            combo
        );
    }
}

#[test]
fn decodes_qr_code_complex_png_in_every_combination() {
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_code_complex.png");
    for combo in ALL_COMBOS {
        let bytes = decode_combo(&rgba, w, h, combo).unwrap_or_else(|| {
            panic!("qr_code_complex.png failed to decode for combo={:?}", combo)
        });
        assert_eq!(
            bytes.as_slice(),
            b"https://qr-code-styling.com",
            "unexpected bytes for combo={:?}",
            combo
        );
    }
}

#[test]
fn decodes_real_fountain_byte_mode_fixture_in_every_combination() {
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/fountain_binary_real.png");
    for combo in ALL_COMBOS {
        let bytes = decode_combo(&rgba, w, h, combo).unwrap_or_else(|| {
            panic!(
                "fountain_binary_real.png failed to decode for combo={:?}",
                combo
            )
        });
        // Binary fountain payload starts with magic bytes 0xff 0xfd; the bytes-only
        // path returns the raw QR BYTE-mode payload without any UTF-8/Latin-1 mangling.
        assert_eq!(
            &bytes[..2],
            [0xff, 0xfd],
            "wrong magic prefix for combo={:?}",
            combo
        );
    }
}

#[test]
fn qr_sample_inverted_png_requires_try_invert() {
    // Pixel-inverted (255 - rgb) copy of `qr_sample.png`, generated by the
    // ignored `generate_synthetic_fixtures` test below. The synthetic
    // inversion exercises the AlsoInverted hint in isolation: try_harder is
    // unused (image is small and clean), and HybridBinarizer vs
    // GlobalHistogramBinarizer both succeed on the flipped matrix. Decodes
    // iff try_invert = true.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample_inverted.png");
    for combo in ALL_COMBOS {
        let (_, try_invert, _) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if try_invert {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "qr_sample_inverted.png expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(
                bytes.as_slice(),
                b"jfghjghjghfkghjkghj",
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "qr_sample_inverted.png expected to NOT decode without try_invert for combo={:?}",
                combo
            );
        }
    }
}

#[test]
fn qr_sample_small_in_canvas_png_requires_try_harder() {
    // The baseline `qr_sample.png` downscaled to 80x80 and pasted into a
    // 1600x1600 white canvas (see `generate_synthetic_fixtures` below).
    // `FindFinderPatterns` picks skip = (3*1600)/(4*97) ≈ 12 by default;
    // the shrunken finder modules are ~3 px tall, so the coarse scan walks
    // past them and only the dense try_harder=true scan (skip=3) catches
    // one. try_invert and the binarizer choice are both irrelevant.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample_small_in_canvas.png");
    for combo in ALL_COMBOS {
        let (try_harder, _, _) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if try_harder {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "qr_sample_small_in_canvas.png expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(
                bytes.as_slice(),
                b"jfghjghjghfkghjkghj",
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "qr_sample_small_in_canvas.png expected to NOT decode without try_harder for combo={:?}",
                combo
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Binarizer fallback. The wasm wrapper exposes a `binarizer_fallback` option
// that retries the full pipeline once with the opposite binarizer when the
// primary produces no results. Mirrors the `read_inner` policy in
// `rxing-wasm/src/lib.rs`. Validated here against the two binarizer-isolation
// fixtures (each decodes on only one binarizer) — proves fallback rescues
// both failure modes regardless of which binarizer the caller picks first.
// ---------------------------------------------------------------------------

/// Mirror of `read_inner`'s `binarizer_fallback` policy: run the single-symbol
/// pipeline with `primary_use_hybrid`; on miss, run again with the other.
fn decode_with_binarizer_fallback(
    rgba: &[u8],
    w: u32,
    h: u32,
    try_harder: bool,
    try_invert: bool,
    primary_use_hybrid: bool,
) -> Option<Vec<u8>> {
    if let Some(bytes) = decode_combo(rgba, w, h, (try_harder, try_invert, primary_use_hybrid)) {
        return Some(bytes);
    }
    decode_combo(rgba, w, h, (try_harder, try_invert, !primary_use_hybrid))
}

#[test]
fn binarizer_fallback_rescues_qr_complex_2_with_hybrid_primary() {
    // qr-complex-2.png decodes only on GlobalHistogramBinarizer (see
    // `qr_complex_2_png_requires_global_histogram_binarizer`). Caller picks
    // Hybrid as primary; binarizer fallback should retry on Global and decode.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr-complex-2.png");
    let bytes = decode_with_binarizer_fallback(&rgba, w, h, false, false, true)
        .expect("binarizer fallback should rescue via Global");
    assert_eq!(bytes.as_slice(), b"http://scnv.io/MsSv?qr=1");
}

#[test]
fn binarizer_fallback_rescues_vignetted_with_global_primary() {
    // Mirror: qr_sample_vignetted.png decodes only on HybridBinarizer (see
    // `qr_sample_vignetted_png_requires_hybrid_binarizer`). Caller picks
    // Global as primary; binarizer fallback should retry on Hybrid and decode.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample_vignetted.png");
    let bytes = decode_with_binarizer_fallback(&rgba, w, h, false, false, false)
        .expect("binarizer fallback should rescue via Hybrid");
    assert_eq!(bytes.as_slice(), QR_SAMPLE_TEXT);
}

#[test]
fn rgba_length_mismatch_is_rejected() {
    let err = rgba_to_luma(&[0u8; 15], 2, 2).expect_err("expected length-mismatch error");
    assert!(err.contains("rgba length"), "unexpected error: {}", err);
}

// ---------------------------------------------------------------------------
// Real-world fixtures that exercise the `try_harder` pyramid + morphological
// close pre-pass. Neither decodes at the original resolution; both surface
// only after the buffer is downscaled and/or `BinaryBitmap::close()` is
// applied. These pin the capability we lost when `FilteredImageReader` was
// removed and re-added via `read_inner`'s try_harder branch + the
// `BinaryBitmap::close()` / `downscale_luma_buffer` utilities.
// ---------------------------------------------------------------------------

#[test]
fn qr_zoo_jpg_requires_try_harder_and_try_invert() {
    // 2258×1344 phone photo of a white-on-dark-green QR. Needs the pyramid
    // (try_harder) to surface the finders and the in-place flip
    // (try_invert) to read the inverted reflectance.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_zoo.jpg");
    let expected = b"https://zoo.sandiegozoo.org/2024-sdmag-pandas";
    for combo in ALL_COMBOS {
        let (try_harder, try_invert, _) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if try_harder && try_invert {
            let bytes = result
                .unwrap_or_else(|| panic!("qr_zoo.jpg expected to decode for combo={:?}", combo));
            assert_eq!(
                bytes.as_slice(),
                expected.as_slice(),
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "qr_zoo.jpg expected to NOT decode for combo={:?}, got Some({} bytes)",
                combo,
                result.as_ref().map(|b| b.len()).unwrap_or(0)
            );
        }
    }
}

/// Loop over `ALL_COMBOS` asserting that `rgba` decodes to `expected` iff
/// `try_harder = true`. `label` is interpolated into panic messages so test
/// failures point at the specific fixture/transform under test.
fn assert_requires_try_harder(rgba: &[u8], w: u32, h: u32, expected: &[u8], label: &str) {
    for combo in ALL_COMBOS {
        let (try_harder, _, _) = combo;
        let result = decode_combo(rgba, w, h, combo);
        if try_harder {
            let bytes = result
                .unwrap_or_else(|| panic!("{label} expected to decode for combo={combo:?}"));
            assert_eq!(
                bytes.as_slice(),
                expected,
                "{label}: unexpected bytes for combo={combo:?}",
            );
        } else {
            assert!(
                result.is_none(),
                "{label} expected to NOT decode without try_harder for combo={combo:?}",
            );
        }
    }
}

#[test]
fn qr_complex_2_png_requires_global_histogram_binarizer() {
    // 431×431 stylized QR (45°-rotated "diamond" framing, orange finder
    // patterns, orange center logo overlaying the data modules, blue speckled
    // dark modules on white). Decodes iff `use_hybrid_binarizer = false`;
    // `try_harder` and `try_invert` are both irrelevant. The HybridBinarizer's
    // 8×8 local-threshold blocks mis-classify the colored finders and center
    // logo (foreground is medium-bright orange, not black), while the
    // GlobalHistogramBinarizer's single image-wide threshold separates the
    // overall dark/light populations cleanly. Pins the GlobalHistogramBinarizer
    // branch of `decode_one_layer`; the mirror test
    // `qr_sample_vignetted_png_requires_hybrid_binarizer` pins the Hybrid
    // branch, so deleting either binarizer breaks one of the two.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr-complex-2.png");
    let expected = b"http://scnv.io/MsSv?qr=1";
    for combo in ALL_COMBOS {
        let (_, _, use_hybrid_binarizer) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if !use_hybrid_binarizer {
            let bytes = result.unwrap_or_else(|| {
                panic!("qr-complex-2.png expected to decode for combo={:?}", combo)
            });
            assert_eq!(
                bytes.as_slice(),
                expected.as_slice(),
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "qr-complex-2.png expected to NOT decode with HybridBinarizer for combo={:?}, got Some({} bytes)",
                combo,
                result.as_ref().map(|b| b.len()).unwrap_or(0)
            );
        }
    }
}

#[test]
fn qr_sample_vignetted_png_requires_hybrid_binarizer() {
    // qr_sample.png multiplied by a radial gradient from white (centre) to
    // gray50 (corners) — see `fixtures/regen_synthetic.sh`. Strong dark
    // vignette that drops corner luminance to ~50% of centre while preserving
    // local black/white contrast inside each small neighbourhood. The mirror
    // case of `qr_complex_2_png_requires_global_histogram_binarizer`: decodes
    // iff `use_hybrid_binarizer = true`, regardless of `try_harder` /
    // `try_invert`. GlobalHistogramBinarizer's single image-wide threshold
    // can't separate dim-corner whites from bright-centre blacks (overlapping
    // luminance populations); HybridBinarizer's per-8×8-block thresholds
    // adapt to local luminance and decode cleanly. Together with the
    // `qr-complex-2.png` test, this pins both binarizer branches in
    // `decode_one_layer` as load-bearing — neither can be deleted without
    // losing a real-world failure mode.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample_vignetted.png");
    for combo in ALL_COMBOS {
        let (_, _, use_hybrid_binarizer) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if use_hybrid_binarizer {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "qr_sample_vignetted.png expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(
                bytes.as_slice(),
                QR_SAMPLE_TEXT,
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "qr_sample_vignetted.png expected to NOT decode with GlobalHistogramBinarizer for combo={:?}, got Some({} bytes)",
                combo,
                result.as_ref().map(|b| b.len()).unwrap_or(0)
            );
        }
    }
}

#[test]
fn qr_code_complex_rotated_jpg_requires_try_harder() {
    // 183×210 phone photo of a rotated QR encoding a longer URL payload (named
    // `qr_code_complex_rotated.jpg` to flag the long-URL payload, distinct
    // from the short `jfghjghj...` payload in qr_sample.png). The original
    // resolution is below the pyramid threshold so no downscale layer fires;
    // the close-pass (try_harder = true → bitmap.close()) is what surfaces
    // the finders.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_code_complex_rotated.jpg");
    assert_requires_try_harder(
        &rgba,
        w,
        h,
        b"https://nc.cesdk12.org/ncsd/PXP2_Login_Parent.aspx?regenerateSessionId=True",
        "qr_code_complex_rotated.jpg",
    );
}

// ---------------------------------------------------------------------------
// Rotation tests. The fixture-based option-isolation tests above don't cover
// rotation (none of the fixtures are pre-rotated). These exercise the
// rotation invariance built into rxing's QR detector by rotating the
// baseline fixture in-memory before decoding.
// ---------------------------------------------------------------------------

const QR_SAMPLE_TEXT: &[u8] = b"jfghjghjghfkghjkghj";

fn invert_rgba(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| [255 - p[0], 255 - p[1], 255 - p[2], p[3]])
        .collect()
}

/// Rotate an RGBA buffer 90° clockwise. Source (x, y) maps to dst (h - 1 - y, x).
fn rotate_rgba_90_cw(rgba: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let (w_us, h_us) = (w as usize, h as usize);
    let mut out = vec![0u8; rgba.len()];
    for y in 0..h_us {
        for x in 0..w_us {
            let src = (y * w_us + x) * 4;
            let dx = h_us - 1 - y;
            let dy = x;
            let dst = (dy * h_us + dx) * 4;
            out[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
        }
    }
    (out, h, w)
}

#[test]
fn inverted_qr_sample_in_memory_requires_try_invert() {
    // In-memory parallel of `qr_sample_inverted_png_requires_try_invert`:
    // pixel-inverts the baseline RGBA at test time instead of loading the
    // pre-inverted PNG from disk. Catches regressions to the
    // `decode_with_optional_invert` flip path that wouldn't surface if the
    // fixture file is out of date / corrupted / missing.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let inverted = invert_rgba(&rgba);

    for combo in ALL_COMBOS {
        let (_, try_invert, _) = combo;
        let result = decode_combo(&inverted, w, h, combo);
        if try_invert {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "in-memory inverted qr_sample expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(bytes.as_slice(), QR_SAMPLE_TEXT);
        } else {
            assert!(
                result.is_none(),
                "in-memory inverted qr_sample expected to NOT decode without try_invert for combo={:?}",
                combo
            );
        }
    }
}

#[test]
fn qr_sample_rotated_speckled_png_requires_try_harder() {
    // Synthetic, clean-source analog of `qr_code_complex_rotated_jpg_requires_try_harder`:
    // qr_sample.png nearest-neighbor rotated 17° (staircase aliasing along
    // finder edges) plus a sparse white-salt mask (1-pixel holes inside dark
    // modules). Generated by `fixtures/regen_synthetic.sh`.
    //
    // rxing's detector is rotation-invariant for clean fixtures (see
    // `rotated_qr_sample_decodes_natively`), so rotation alone isn't enough
    // — the salt is what defeats the original-resolution scan, and the
    // `try_harder = true` morphological close-pass is what fills the holes
    // and rescues detection. Pins the close-pass branch of `decode_inner`
    // without depending on the JPG fixture (which conflates rotation, motion
    // blur, JPEG noise, and low resolution into a single failure mode).
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample_rotated_speckled.png");
    assert_requires_try_harder(
        &rgba,
        w,
        h,
        QR_SAMPLE_TEXT,
        "qr_sample_rotated_speckled.png",
    );
}

#[test]
fn rotated_qr_sample_decodes_natively() {
    // rxing's QR finder reorders the three concentric finder patterns into a
    // canonical (TL, TR, BL) tri-corner before sampling, so a clean QR decodes
    // at every 90° orientation. A future regression (e.g. losing the
    // canonical reordering) would surface here as a decode miss.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let (rotated, rw, rh) = rotate_rgba_90_cw(&rgba, w, h);

    let bytes = decode_combo(&rotated, rw, rh, (false, false, true))
        .expect("rxing's QR detector should be rotation-invariant for clean fixtures");
    assert_eq!(bytes.as_slice(), QR_SAMPLE_TEXT);
}

/// Diagnostic: prints which `(try_harder, try_invert, use_hybrid_binarizer)`
/// combos decode each fixture. Marked `#[ignore]` so it doesn't run in the
/// normal suite; rerun with `cargo test --test qr_decode probe -- --ignored --nocapture`.
#[test]
#[ignore]
fn probe_fixture_requirements() {
    let fixtures: &[(&str, &[u8])] = &[
        ("qr_sample.png", b"jfghjghjghfkghjkghj"),
        ("qr_code_complex.png", b"https://qr-code-styling.com"),
        ("qr_sample_inverted.png", b"jfghjghjghfkghjkghj"),
        ("qr_sample_small_in_canvas.png", b"jfghjghjghfkghjkghj"),
        ("qr_zoo.jpg", b"https://zoo.sandiegozoo.org/2024-sdmag-pandas"),
        (
            "qr_code_complex_rotated.jpg",
            b"https://nc.cesdk12.org/ncsd/PXP2_Login_Parent.aspx?regenerateSessionId=True",
        ),
        ("qr_sample_rotated_speckled.png", b"jfghjghjghfkghjkghj"),
        ("qr-complex-2.png", b"http://scnv.io/MsSv?qr=1"),
        ("qr_sample_vignetted.png", b"jfghjghjghfkghjkghj"),
    ];
    for (name, expected) in fixtures {
        let path = format!("tests/fixtures/{name}");
        let (rgba, w, h) = load_image_as_rgba(&path);
        println!("--- {name} ({w}x{h}) ---");
        for combo in ALL_COMBOS {
            let got = decode_combo(&rgba, w, h, combo);
            let label = match &got {
                Some(b) if expected.is_empty() => {
                    format!("ok ({})", String::from_utf8_lossy(b))
                }
                Some(b) if b.as_slice() == *expected => "ok".to_string(),
                Some(_) => "WRONG".to_string(),
                None => "miss".to_string(),
            };
            println!("  hard={} inv={} hyb={} -> {}", combo.0, combo.1, combo.2, label);
        }
    }
}

#[test]
fn rotated_and_inverted_qr_sample_requires_try_invert() {
    // Compose both transforms. Rotation alone is handled natively (see
    // `rotated_qr_sample_decodes_natively`) but the inversion still requires
    // `try_invert`. Pins that the manual BitMatrix flip in `decode_inner`
    // composes correctly with a rotated source: every try_invert=true combo
    // decodes, every try_invert=false combo (including try_harder=true, which
    // could plausibly rescue via the close-pass / pyramid) misses.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let (rotated, rw, rh) = rotate_rgba_90_cw(&rgba, w, h);
    let rotated_inverted = invert_rgba(&rotated);

    for combo in ALL_COMBOS {
        let (_, try_invert, _) = combo;
        let result = decode_combo(&rotated_inverted, rw, rh, combo);
        if try_invert {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "rotated-inverted qr_sample expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(
                bytes.as_slice(),
                QR_SAMPLE_TEXT,
                "unexpected bytes for combo={:?}",
                combo
            );
        } else {
            assert!(
                result.is_none(),
                "rotated-inverted qr_sample expected to NOT decode without try_invert for combo={:?}",
                combo
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Multi-symbol decode tests. The production wrapper (`rxing-wasm` + the JS
// `readQrCodesFromRgba` util) hard-codes the count cap to 1 because every
// app consumer reads only `results[0]`. These tests pin the underlying
// `decode_set_number_with_hints` multi-decode capability so a future caller
// that needs >1 symbol per frame won't silently regress.
//
// Fixtures `qr_two_codes.png` and `qr_three_codes.png` are synthetic
// side-by-side composites of `qr_sample.png` + `qr_code_complex.png`
// generated by `fixtures/regen_synthetic.sh`.
// ---------------------------------------------------------------------------

/// Multi-symbol decode. Bypasses the inversion/pyramid/close pipeline used
/// by `decode_inner` because the multi-QR fixtures are clean upright
/// composites — only the multi-decode loop itself needs exercising. `count`
/// is forwarded verbatim to `decode_set_number_with_hints` (0 = unlimited).
fn decode_all(rgba: &[u8], w: u32, h: u32, count: u32) -> Vec<Vec<u8>> {
    let luma = rgba_to_luma(rgba, w, h).expect("luma");
    let source = Luma8LuminanceSource::new(luma, w, h);
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        ..DecodeHints::default()
    };
    QrReader
        .decode_set_number_with_hints(&mut bitmap, &hints, count)
        .map(|results| {
            results
                .into_iter()
                .map(|r| r.getRawBytes().to_vec())
                .collect()
        })
        .unwrap_or_default()
}

const QR_COMPLEX_TEXT: &[u8] = b"https://qr-code-styling.com";

#[test]
fn decodes_two_qr_codes_in_single_image() {
    // Side-by-side composite of the two clean QR fixtures. Verifies that
    // FindFinderPatterns surfaces both independent finder-pattern triples
    // and that the multi-decode loop returns both payloads when the count
    // cap permits.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_two_codes.png");
    let decoded = decode_all(&rgba, w, h, 8);
    assert_eq!(
        decoded.len(),
        2,
        "expected both QR codes to decode, got {} results",
        decoded.len()
    );
    let payloads: HashSet<&[u8]> = decoded.iter().map(|v| v.as_slice()).collect();
    assert!(
        payloads.contains(QR_SAMPLE_TEXT),
        "missing qr_sample payload; got {:?}",
        decoded
            .iter()
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .collect::<Vec<_>>()
    );
    assert!(
        payloads.contains(QR_COMPLEX_TEXT),
        "missing qr_code_complex payload; got {:?}",
        decoded
            .iter()
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .collect::<Vec<_>>()
    );
}

#[test]
fn count_cap_of_one_returns_single_symbol_from_multi_qr_image() {
    // Same two-QR fixture, but with count = 1: the multi-decode loop
    // must short-circuit after the first valid symbol. Pins the
    // single-symbol fast path used by the rxing-wasm wrapper in
    // production (see `MAX_NUMBER_OF_SYMBOLS` in src/utils/rxingWasm.ts).
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_two_codes.png");
    let decoded = decode_all(&rgba, w, h, 1);
    assert_eq!(
        decoded.len(),
        1,
        "count=1 should cap result vec at length 1, got {}",
        decoded.len()
    );
    let payload = decoded[0].as_slice();
    assert!(
        payload == QR_SAMPLE_TEXT || payload == QR_COMPLEX_TEXT,
        "unexpected payload from count-capped decode: {:?}",
        String::from_utf8_lossy(payload)
    );
}

#[test]
fn count_zero_returns_every_symbol_in_multi_qr_image() {
    // count = 0 is documented as "unlimited" in
    // `decode_set_number_with_hints`. Pin that contract against the
    // two-QR fixture.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_two_codes.png");
    let decoded = decode_all(&rgba, w, h, 0);
    assert_eq!(
        decoded.len(),
        2,
        "count=0 (unlimited) should return both symbols, got {}",
        decoded.len()
    );
}

#[test]
fn decodes_three_qr_codes_in_single_image() {
    // Three-symbol fixture: qr_sample twice plus qr_code_complex.
    // Exercises that the multi-decode loop keeps iterating past two and
    // that two identical payloads in the same image don't collapse into
    // a single result (FindFinderPatterns yields three independent
    // triples, decode returns three results).
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_three_codes.png");
    let decoded = decode_all(&rgba, w, h, 0);
    assert_eq!(
        decoded.len(),
        3,
        "expected three QR codes to decode, got {} results: {:?}",
        decoded.len(),
        decoded
            .iter()
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .collect::<Vec<_>>()
    );
    let sample_hits = decoded.iter().filter(|v| v.as_slice() == QR_SAMPLE_TEXT).count();
    let complex_hits = decoded.iter().filter(|v| v.as_slice() == QR_COMPLEX_TEXT).count();
    assert_eq!(sample_hits, 2, "expected qr_sample payload twice");
    assert_eq!(complex_hits, 1, "expected qr_code_complex payload once");
}
