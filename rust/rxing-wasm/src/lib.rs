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
    let mut hints = DecodeHints {
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
        reader.decode_with_hints(&mut bitmap, &mut hints)
    } else {
        let mut reader = MultiFormatReader::default();
        if use_hybrid_binarizer {
            let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
            reader.decode_with_hints(&mut bitmap, &mut hints)
        } else {
            let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
            reader.decode_with_hints(&mut bitmap, &mut hints)
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

    #[test]
    fn decodes_qr_sample_png() {
        let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_sample.png");
        let luma = rgba_to_luma(&rgba, w, h).expect("luma");
        let bytes = decode_inner(luma, w, h, true, true, true)
            .expect("expected a QR decode result from tests/fixtures/qr_sample.png");
        assert_eq!(bytes.as_slice(), b"jfghjghjghfkghjkghj");
    }

    #[test]
    fn decodes_qr_code_complex_png() {
        let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_code_complex.png");
        let luma = rgba_to_luma(&rgba, w, h).expect("luma");
        let bytes = decode_inner(luma, w, h, true, true, true)
            .expect("expected a QR decode result from tests/fixtures/qr_code_complex.png");
        assert_eq!(bytes.as_slice(), b"https://qr-code-styling.com");
    }

    #[test]
    fn decodes_qr_zoo_jpg() {
        let (rgba, w, h) = load_image_as_rgba("tests/fixtures/qr_zoo.jpg");
        let luma = rgba_to_luma(&rgba, w, h).expect("luma");
        let bytes = decode_inner(luma, w, h, true, true, true)
            .expect("expected a QR decode result from tests/fixtures/qr_zoo.jpg");
        assert_eq!(bytes.as_slice(), b"https://zoo.sandiegozoo.org/2024-sdmag-pandas");
    }

    #[test]
    fn decodes_real_fountain_byte_mode_fixture_losslessly() {
        let (rgba, w, h) = load_image_as_rgba("tests/fixtures/fountain_binary_real.png");

        for try_harder in [false, true] {
            let luma = rgba_to_luma(&rgba, w, h).expect("luma");
            let bytes = decode_inner(luma, w, h, try_harder, false, true)
                .expect("expected a QR decode result from real fountain byte-mode fixture");

            // Binary fountain payload starts with magic bytes 0xff 0xfd; the bytes-only
            // path returns the raw QR BYTE-mode payload without any UTF-8/Latin-1 mangling.
            assert_eq!(&bytes[..2], [0xff, 0xfd]);
        }
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
