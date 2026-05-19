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
