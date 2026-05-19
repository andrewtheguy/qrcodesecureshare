use std::collections::HashSet;

use rxing::{
    common::{GlobalHistogramBinarizer, HybridBinarizer},
    qrcode::cpp_port::QrReader,
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource, LuminanceSource,
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

/// Run a single decode pass at a given orientation / inversion combination.
///
/// `QrReader::decode_set_number_with_hints` does not honor `AlsoInverted`
/// (that path is in `MultiFormatReader`, which we deliberately bypass), so
/// inversion is implemented here by flipping the BitMatrix before decoding.
fn decode_one_pass(
    source: Luma8LuminanceSource,
    hints: &DecodeHints,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
    invert: bool,
) -> Vec<Vec<u8>> {
    let results = if use_hybrid_binarizer {
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        if invert {
            let Ok(matrix) = bitmap.get_black_matrix_mut() else {
                return Vec::new();
            };
            matrix.flip_self();
        }
        QrReader.decode_set_number_with_hints(&mut bitmap, hints, max_number_of_symbols)
    } else {
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        if invert {
            let Ok(matrix) = bitmap.get_black_matrix_mut() else {
                return Vec::new();
            };
            matrix.flip_self();
        }
        QrReader.decode_set_number_with_hints(&mut bitmap, hints, max_number_of_symbols)
    };

    results
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.getRawBytes().to_vec())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn read_inner(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    try_rotate: bool,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Vec<Vec<u8>> {
    // `AlsoInverted` is intentionally omitted from `hints` because the
    // QrReader multi-decode entry point doesn't consume it — inversion is
    // handled externally via `decode_one_pass(..., invert: true)`.
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        TryHarder: Some(try_harder),
        ..DecodeHints::default()
    };

    let mut source = Luma8LuminanceSource::new(luma, width, height);
    let rotations = if try_rotate { 4 } else { 1 };

    for rot in 0..rotations {
        let results = decode_one_pass(
            source.clone(),
            &hints,
            use_hybrid_binarizer,
            max_number_of_symbols,
            false,
        );
        if !results.is_empty() {
            return results;
        }

        if try_invert {
            let results = decode_one_pass(
                source.clone(),
                &hints,
                use_hybrid_binarizer,
                max_number_of_symbols,
                true,
            );
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

/// Read every QR code in raw RGBA pixels, returning each payload's raw bytes.
///
/// - `rgba`: row-major RGBA pixels, length must equal `width * height * 4`
/// - `try_harder`: spend more time looking for a barcode (densifies the
///   finder-pattern scan via rxing's `TryHarder` hint)
/// - `try_invert`: retry with the BitMatrix flipped if the first pass yields
///   no results (covers white-on-dark / inverted-reflectance codes)
/// - `try_rotate`: retry at 90°, 180°, 270° rotations if earlier passes yield
///   no results (covers cameras held sideways / upside-down)
/// - `use_hybrid_binarizer`: when `true`, use rxing's adaptive
///   `HybridBinarizer`; when `false`, the faster but less robust
///   `GlobalHistogramBinarizer`
/// - `max_number_of_symbols`: cap the number of symbols returned per pass.
///   Pass `0` to remove the cap. Pass `1` when only one detection is needed —
///   lets the multi-decode loop short-circuit on the first valid result and
///   skips Micro QR / rMQR fallbacks once a QR is found.
///
/// Retry order when no results are found: original → (invert) → 90° →
/// (90° invert) → 180° → (180° invert) → 270° → (270° invert). The first
/// pass that produces results wins; remaining passes are skipped.
///
/// Returns a JS `Array` of `Uint8Array`, one per detected symbol (empty when
/// none are found). Returns `Err` only for invalid input (e.g. mismatched
/// buffer length). Callers that need a string must decode the bytes themselves
/// (e.g. `new TextDecoder().decode(bytes)`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn read_qr_codes_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    try_rotate: bool,
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
        try_rotate,
        use_hybrid_binarizer,
        max_number_of_symbols,
    );

    let out = js_sys::Array::new_with_length(payloads.len() as u32);
    for (i, bytes) in payloads.into_iter().enumerate() {
        out.set(i as u32, js_sys::Uint8Array::from(bytes.as_slice()).into());
    }
    Ok(out)
}
