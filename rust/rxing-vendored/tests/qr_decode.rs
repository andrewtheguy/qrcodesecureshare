use std::collections::HashSet;
use std::path::PathBuf;

use image::ImageReader;
use rxing::{
    BarcodeFormat, BinaryBitmap, DecodeHints, FilteredImageReader, Luma8LuminanceSource,
    LuminanceSource, MultiFormatReader, Reader,
    common::{GlobalHistogramBinarizer, HybridBinarizer},
    qrcode::cpp_port::QrReader,
};

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
        AlsoInverted: Some(try_invert),
        ..DecodeHints::default()
    };

    let source = Luma8LuminanceSource::new(luma, width, height);

    let result = if try_harder {
        let mut reader = FilteredImageReader::new(MultiFormatReader::default());
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        reader.decode_with_hints(&mut bitmap, &hints)
    } else {
        let mut reader = MultiFormatReader::default();
        if use_hybrid_binarizer {
            let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
            reader.decode_with_hints(&mut bitmap, &hints)
        } else {
            let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
            reader.decode_with_hints(&mut bitmap, &hints)
        }
    };

    Some(result.ok()?.getRawBytes().to_vec())
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
// Note: when `try_harder = true`, `FilteredImageReader` overrides the binarizer
// choice (always HybridBinarizer + pyramid). The hybrid-flag combos are still
// included so a future regression that re-introduces the flag's effect there
// would be caught.
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

#[test]
fn qr_rotated_jpg_requires_try_harder() {
    // Real phone photo of a rotated QR code (added to test rotation-handling
    // in a non-synthetic image). Decodes only with try_harder = true, and
    // independently of the HybridBinarizer / GlobalHistogramBinarizer choice.
    //
    // Quirk: under the legacy `MultiFormatReader` + `FilteredImageReader`
    // path tested here, setting `try_invert = true` *breaks* the close-pass
    // fallback — when `AlsoInverted = true` and the first close=false
    // decode fails, the matrix is left flipped before `BinaryBitmap::close`
    // runs on the close=true iteration, so the morphological close is
    // applied to the inverted image instead of the original. This affects
    // only the legacy path (the wasm wrapper uses `QrReader` directly +
    // manual flip and doesn't have this interaction). Asserted only for
    // try_invert = false.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_rotated.jpg");
    let expected = b"https://nc.cesdk12.org/ncsd/PXP2_Login_Parent.aspx?regenerateSessionId=True";
    for combo in ALL_COMBOS {
        let (try_harder, try_invert, _) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if try_harder && !try_invert {
            let bytes = result.unwrap_or_else(|| {
                panic!(
                    "qr_rotated.jpg expected to decode for combo={:?}",
                    combo
                )
            });
            assert_eq!(
                bytes.as_slice(),
                expected.as_slice(),
                "unexpected bytes for combo={:?}",
                combo
            );
        } else if !try_harder {
            assert!(
                result.is_none(),
                "qr_rotated.jpg expected to NOT decode without try_harder for combo={:?}",
                combo
            );
        }
        // try_harder && try_invert: legacy path quirk above — don't assert.
    }
}

#[test]
fn qr_zoo_jpg_requires_try_harder_and_try_invert() {
    // White-on-dark-green phone photo: needs the FilteredImageReader pyramid
    // (try_harder) AND inverted retry (try_invert). The binarizer flag has
    // no effect when try_harder=true.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_zoo.jpg");
    for combo in ALL_COMBOS {
        let (try_harder, try_invert, _) = combo;
        let result = decode_combo(&rgba, w, h, combo);
        if try_harder && try_invert {
            let bytes = result
                .unwrap_or_else(|| panic!("qr_zoo.jpg expected to decode for combo={:?}", combo));
            assert_eq!(
                bytes.as_slice(),
                b"https://zoo.sandiegozoo.org/2024-sdmag-pandas",
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

#[test]
fn rgba_length_mismatch_is_rejected() {
    let err = rgba_to_luma(&[0u8; 15], 2, 2).expect_err("expected length-mismatch error");
    assert!(err.contains("rgba length"), "unexpected error: {}", err);
}

// ---------------------------------------------------------------------------
// rxing-wasm equivalence tests. These exercise the QR-only multi-decode path
// (`QrReader::decode_set_number_with_hints`) plus the manual BitMatrix flip
// (try_invert) and manual `Luma8LuminanceSource::rotate_counter_clockwise()`
// (try_rotate) that the wasm wrapper layers on top.
// ---------------------------------------------------------------------------

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

fn decode_one_pass(source: Luma8LuminanceSource, hints: &DecodeHints, invert: bool) -> Vec<Vec<u8>> {
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
    if invert {
        let Ok(matrix) = bitmap.get_black_matrix_mut() else {
            return Vec::new();
        };
        matrix.flip_self();
    }
    QrReader
        .decode_set_number_with_hints(&mut bitmap, hints, 1)
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.getRawBytes().to_vec())
        .collect()
}

/// Mirror of the wasm wrapper's `read_inner`. Tests against this path catch
/// regressions to the QR-only multi-decode plus retry loop.
fn decode_with_retry(
    rgba: &[u8],
    w: u32,
    h: u32,
    try_invert: bool,
    try_rotate: bool,
) -> Vec<Vec<u8>> {
    let luma = rgba_to_luma(rgba, w, h).expect("luma");
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        ..DecodeHints::default()
    };

    let mut source = Luma8LuminanceSource::new(luma, w, h);
    let rotations = if try_rotate { 4 } else { 1 };

    for rot in 0..rotations {
        let results = decode_one_pass(source.clone(), &hints, false);
        if !results.is_empty() {
            return results;
        }
        if try_invert {
            let results = decode_one_pass(source.clone(), &hints, true);
            if !results.is_empty() {
                return results;
            }
        }
        if rot + 1 < rotations {
            match source.rotate_counter_clockwise() {
                Ok(rotated) => source = rotated,
                Err(_) => break,
            }
        }
    }

    Vec::new()
}

const QR_SAMPLE_TEXT: &[u8] = b"jfghjghjghfkghjkghj";

#[test]
fn inverted_qr_sample_requires_try_invert() {
    // Pixel-invert the baseline fixture (255 - rgb per channel). The QrReader
    // multi-decode entry point does NOT consume the `AlsoInverted` hint (that
    // wiring lives in `MultiFormatReader`, which the wasm wrapper bypasses),
    // so the inverted bitmap is only readable when the caller flips the
    // BitMatrix manually — i.e. when `try_invert = true` in the retry loop.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let inverted = invert_rgba(&rgba);

    let without = decode_with_retry(&inverted, w, h, false, false);
    assert!(
        without.is_empty(),
        "inverted fixture unexpectedly decoded without try_invert ({} result(s))",
        without.len()
    );

    let with = decode_with_retry(&inverted, w, h, true, false);
    assert_eq!(with.len(), 1, "try_invert should rescue the inverted fixture");
    assert_eq!(with[0].as_slice(), QR_SAMPLE_TEXT);
}

#[test]
fn rotated_qr_sample_decodes_without_try_rotate() {
    // rxing's QR finder reorders the three concentric finder patterns into a
    // canonical (TL, TR, BL) tri-corner before sampling, so a clean QR decodes
    // at every 90° orientation even with `try_rotate = false`. This pins that
    // behavior — a future regression (e.g. losing the canonical reordering)
    // would surface here as a "without_rotate" failure.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let (rotated, rw, rh) = rotate_rgba_90_cw(&rgba, w, h);

    let without = decode_with_retry(&rotated, rw, rh, false, false);
    assert_eq!(
        without.len(),
        1,
        "rxing's QR detector should be rotation-invariant for clean fixtures"
    );
    assert_eq!(without[0].as_slice(), QR_SAMPLE_TEXT);
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
        ("qr_zoo.jpg", b"https://zoo.sandiegozoo.org/2024-sdmag-pandas"),
        ("qr_sample_inverted.png", b"jfghjghjghfkghjkghj"),
        ("qr_sample_small_in_canvas.png", b"jfghjghjghfkghjkghj"),
        ("qr_rotated.jpg", b""),
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
    // Compose both transforms. Rotation alone is handled natively (see test
    // above) but the inversion still requires `try_invert`. This verifies the
    // retry loop reaches the matching (rotation × inversion) combination.
    let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
    let (rotated, rw, rh) = rotate_rgba_90_cw(&rgba, w, h);
    let rotated_inverted = invert_rgba(&rotated);

    let without = decode_with_retry(&rotated_inverted, rw, rh, false, false);
    assert!(
        without.is_empty(),
        "rotated-inverted fixture unexpectedly decoded without try_invert"
    );

    let with = decode_with_retry(&rotated_inverted, rw, rh, true, false);
    assert_eq!(with.len(), 1);
    assert_eq!(with[0].as_slice(), QR_SAMPLE_TEXT);
}
