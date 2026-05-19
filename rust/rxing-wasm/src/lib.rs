use std::collections::HashSet;

use rxing::{
    common::{GlobalHistogramBinarizer, HybridBinarizer},
    qrcode::cpp_port::QrReader,
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource,
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

fn read_inner(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Vec<Vec<u8>> {
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        TryHarder: Some(try_harder),
        AlsoInverted: Some(try_invert),
        ..DecodeHints::default()
    };

    let source = Luma8LuminanceSource::new(luma, width, height);
    let reader = QrReader;

    // `max_number_of_symbols` caps the multi-decode loop inside `QrReader`. Pass `0`
    // for "no limit"; pass `1` for the fountain-scanner fast path. The `TryHarder`
    // hint flows into the finder-pattern search density inside `QrReader`.
    let results = if use_hybrid_binarizer {
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        reader.decode_set_number_with_hints(&mut bitmap, &hints, max_number_of_symbols)
    } else {
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        reader.decode_set_number_with_hints(&mut bitmap, &hints, max_number_of_symbols)
    };

    results
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.getRawBytes().to_vec())
        .collect()
}

/// Read every QR code in raw RGBA pixels, returning each payload's raw bytes.
///
/// - `rgba`: row-major RGBA pixels, length must equal `width * height * 4`
/// - `try_harder`: spend more time looking for a barcode (maps to rxing's `TryHarder` hint)
/// - `try_invert`: also try an inverted image (maps to rxing's `AlsoInverted` hint)
/// - `use_hybrid_binarizer`: when true, use rxing's adaptive `HybridBinarizer`; when
///   false, use the faster but less robust `GlobalHistogramBinarizer`.
/// - `max_number_of_symbols`: cap the number of symbols returned. Pass `0` to
///   remove the cap. Pass `1` when the caller only needs one detection per frame
///   (lets the multi-decode loop short-circuit on the first valid result).
///
/// Returns a JS `Array` of `Uint8Array`, one per detected symbol (empty when none
/// are found). Returns `Err` only for invalid input (e.g. mismatched buffer length).
/// Callers that need a string must decode the bytes themselves
/// (e.g. `new TextDecoder().decode(bytes)`).
#[wasm_bindgen]
pub fn read_qr_codes_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Result<js_sys::Array, JsValue> {
    let luma = rgba_to_luma(rgba, width, height).map_err(|m| JsValue::from_str(&m))?;
    let payloads = read_inner(
        luma,
        width,
        height,
        try_harder,
        try_invert,
        use_hybrid_binarizer,
        max_number_of_symbols,
    );

    let out = js_sys::Array::new_with_length(payloads.len() as u32);
    for (i, bytes) in payloads.into_iter().enumerate() {
        out.set(i as u32, js_sys::Uint8Array::from(bytes.as_slice()).into());
    }
    Ok(out)
}
