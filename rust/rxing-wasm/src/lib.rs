use std::collections::HashSet;

use rxing::{
    common::{GlobalHistogramBinarizer, HybridBinarizer},
    BarcodeFormat, BinaryBitmap, DecodeHints, FilteredImageReader, Luma8LuminanceSource,
    MultiFormatReader, Reader,
};
use wasm_bindgen::prelude::*;

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
        // FilteredImageReader walks a downscale pyramid + morphological-close pass; this is
        // rxing's tough-photo path and the closest match to zxing-wasm's `tryDownscale`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageReader;
    use std::path::PathBuf;

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
    fn qr_zoo_jpg_requires_try_harder_and_try_invert() {
        // White-on-dark-green phone photo: needs the FilteredImageReader pyramid
        // (try_harder) AND inverted retry (try_invert). The binarizer flag has
        // no effect when try_harder=true.
        let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_zoo.jpg");
        for combo in ALL_COMBOS {
            let (try_harder, try_invert, _) = combo;
            let result = decode_combo(&rgba, w, h, combo);
            if try_harder && try_invert {
                let bytes = result.unwrap_or_else(|| {
                    panic!("qr_zoo.jpg expected to decode for combo={:?}", combo)
                });
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
        // Public entrypoint surfaces a JsValue error; the internal helper returns Err.
        let err = rgba_to_luma(&[0u8; 15], 2, 2).expect_err("expected length-mismatch error");
        assert!(err.contains("rgba length"), "unexpected error: {}", err);
    }
}

/// Decode a single QR code from raw RGBA pixels, returning the raw QR byte payload.
///
/// - `rgba`: row-major RGBA pixels, length must equal `width * height * 4`
/// - `try_harder`: spend more time looking for a barcode (maps to rxing's `TryHarder` hint)
/// - `try_invert`: also try an inverted image (maps to rxing's `AlsoInverted` hint)
/// - `use_hybrid_binarizer`: when true, use rxing's adaptive `HybridBinarizer`; when
///   false, use the faster but less robust `GlobalHistogramBinarizer`.
///
/// Returns `Ok(None)` when no QR code is found. Returns `Err` only for invalid input
/// (e.g. mismatched buffer length). Callers that need a string must decode the bytes
/// themselves (e.g. `new TextDecoder().decode(bytes)`).
#[wasm_bindgen]
pub fn decode_qr_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
) -> Result<Option<Vec<u8>>, JsValue> {
    let luma = rgba_to_luma(rgba, width, height).map_err(|m| JsValue::from_str(&m))?;
    Ok(decode_inner(
        luma,
        width,
        height,
        try_harder,
        try_invert,
        use_hybrid_binarizer,
    ))
}
