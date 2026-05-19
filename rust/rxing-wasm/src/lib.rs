use std::collections::HashSet;

use rxing::{
    BarcodeFormat, Binarizer, BinaryBitmap, DecodeHints, Luma8LuminanceSource, RXingResult,
    common::{GlobalHistogramBinarizer, HybridBinarizer, Result as RxingResult},
    downscale_luma_buffer,
    qrcode::cpp_port::QrReader,
};
use wasm_bindgen::prelude::*;

/// Pyramid downscale threshold and factor — mirror zxing-cpp's
/// `tryDownscale` defaults (and what the old `FilteredImageReader` used).
/// Stop downscaling once the smaller side falls below `THRESHOLD`.
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

fn collect_bytes(results: RxingResult<Vec<RXingResult>>) -> Vec<Vec<u8>> {
    results
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.getRawBytes().to_vec())
        .collect()
}

/// Decode on `bitmap` once, then (when `try_invert`) flip the BitMatrix in
/// place and decode again. No clones — the bitmap is consumed once per
/// `read_inner` orientation. `QrReader::decode_set_number_with_hints` does not
/// honor `AlsoInverted` (that path was in the removed `MultiFormatReader`),
/// so the inverted retry has to be driven externally.
fn decode_with_optional_invert<B: Binarizer>(
    bitmap: &mut BinaryBitmap<B>,
    hints: &DecodeHints,
    max_number_of_symbols: u32,
    try_invert: bool,
) -> Vec<Vec<u8>> {
    let results = collect_bytes(QrReader.decode_set_number_with_hints(
        bitmap,
        hints,
        max_number_of_symbols,
    ));
    if !results.is_empty() {
        return results;
    }
    if try_invert {
        if let Ok(matrix) = bitmap.get_black_matrix_mut() {
            matrix.flip_self();
            return collect_bytes(QrReader.decode_set_number_with_hints(
                bitmap,
                hints,
                max_number_of_symbols,
            ));
        }
    }
    Vec::new()
}

/// Try one resolution × close pass: build a fresh BinaryBitmap from
/// `source` (consumed), apply optional morphological close, then decode
/// with optional invert retry. Returns results or empty vec.
fn decode_one_layer(
    source: Luma8LuminanceSource,
    hints: &DecodeHints,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
    try_invert: bool,
    close: bool,
) -> Vec<Vec<u8>> {
    if use_hybrid_binarizer {
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        if close && bitmap.close().is_err() {
            return Vec::new();
        }
        decode_with_optional_invert(&mut bitmap, hints, max_number_of_symbols, try_invert)
    } else {
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        if close && bitmap.close().is_err() {
            return Vec::new();
        }
        decode_with_optional_invert(&mut bitmap, hints, max_number_of_symbols, try_invert)
    }
}

fn read_inner_one_binarizer(
    luma: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
    max_number_of_symbols: u32,
) -> Vec<Vec<u8>> {
    // `AlsoInverted` and `PureBarcode` are intentionally omitted from
    // `hints` — neither has a consumer left in `rxing-vendored` after the
    // legacy-path removal. Inversion is handled by the in-place `flip_self`
    // retry inside `decode_with_optional_invert`.
    let hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        TryHarder: Some(try_harder),
        ..DecodeHints::default()
    };

    // Fast path (no try_harder): original resolution only, no close pass,
    // no pyramid. The source is moved straight into the binarizer with
    // zero clones — matches zxing-wasm's tryHarder=false cost.
    if !try_harder {
        let source = Luma8LuminanceSource::new(luma.to_vec(), width, height);
        return decode_one_layer(
            source,
            &hints,
            use_hybrid_binarizer,
            max_number_of_symbols,
            try_invert,
            false,
        );
    }

    // try_harder path: original resolution, then morphological close, then
    // downscale by `PYRAMID_DOWNSCALE_FACTOR` and repeat until the smaller
    // side falls below `PYRAMID_DOWNSCALE_THRESHOLD`. Each layer tries
    // both close=false and close=true. Mirrors zxing-cpp's `tryDownscale`
    // + `tryDenoise` pipeline (and the removed `FilteredImageReader`).
    let mut cur_luma = luma.to_vec();
    let mut cur_w = width;
    let mut cur_h = height;
    loop {
        for &close in &[false, true] {
            let source = Luma8LuminanceSource::new(cur_luma.clone(), cur_w, cur_h);
            let results = decode_one_layer(
                source,
                &hints,
                use_hybrid_binarizer,
                max_number_of_symbols,
                try_invert,
                close,
            );
            if !results.is_empty() {
                return results;
            }
        }
        // Can we downscale further?
        if cur_w.max(cur_h) <= PYRAMID_DOWNSCALE_THRESHOLD
            || cur_w.min(cur_h) < PYRAMID_DOWNSCALE_FACTOR
        {
            break;
        }
        let (next_luma, next_w, next_h) =
            downscale_luma_buffer(&cur_luma, cur_w, cur_h, PYRAMID_DOWNSCALE_FACTOR);
        cur_luma = next_luma;
        cur_w = next_w;
        cur_h = next_h;
    }

    Vec::new()
}

/// Run the decode pipeline once with `use_hybrid_binarizer`, then — when
/// `binarizer_fallback` is set and the first pass produced nothing — once
/// more with the opposite binarizer. The two rxing binarizers fail on
/// disjoint inputs (Hybrid loses on stylized clean-bg QRs with colored
/// finders; Global loses on uneven illumination), so retrying the other
/// rescues both failure modes at the cost of an extra full pipeline pass.
/// Default for the wasm export is `binarizer_fallback = false`, matching
/// upstream zxing-wasm which picks a single binarizer per call.
#[allow(clippy::too_many_arguments)] // mirrors the wasm export signature 1:1
fn read_inner(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
    binarizer_fallback: bool,
    max_number_of_symbols: u32,
) -> Vec<Vec<u8>> {
    let primary = read_inner_one_binarizer(
        &luma,
        width,
        height,
        try_harder,
        try_invert,
        use_hybrid_binarizer,
        max_number_of_symbols,
    );
    if !primary.is_empty() || !binarizer_fallback {
        return primary;
    }
    read_inner_one_binarizer(
        &luma,
        width,
        height,
        try_harder,
        try_invert,
        !use_hybrid_binarizer,
        max_number_of_symbols,
    )
}

/// Read every QR code in raw RGBA pixels, returning each payload's raw bytes.
///
/// - `rgba`: row-major RGBA pixels, length must equal `width * height * 4`
/// - `try_harder`: spend more time looking for a barcode. Walks a downscale
///   pyramid (factor 3, threshold 500 px) and a 3×3 morphological-close
///   pass per layer, in addition to densifying the finder-pattern scan via
///   rxing's `TryHarder` hint. Equivalent to zxing-wasm's
///   `tryHarder + tryDownscale + tryDenoise`.
/// - `try_invert`: retry with the BitMatrix flipped if the first pass yields
///   no results (covers white-on-dark / inverted-reflectance codes).
/// - `use_hybrid_binarizer`: when `true`, use rxing's adaptive
///   `HybridBinarizer`; when `false`, the faster but less robust
///   `GlobalHistogramBinarizer`.
/// - `binarizer_fallback`: when `true` and the primary binarizer produces no
///   results, retry the full pipeline once more with the opposite binarizer.
///   The two binarizers fail on disjoint inputs (Hybrid on stylized clean-bg
///   QRs with colored finders, Global on uneven illumination), so fallback
///   rescues both at the cost of an extra full pipeline pass. Set `false` for
///   battery-critical live scanning, `true` for one-shot image-upload paths.
/// - `max_number_of_symbols`: cap the number of symbols returned per pass.
///   Pass `0` to remove the cap. Pass `1` when only one detection is needed —
///   lets the multi-decode loop short-circuit on the first valid result and
///   skips Micro QR / rMQR fallbacks once a QR is found.
///
/// Retry order when no results: original × invert →
/// (try_harder: original-closed × invert → downscale 1× → 1× closed →
/// downscale 2× → 2× closed → …). The first pass that produces results
/// wins; remaining passes are skipped.
///
/// Rotation is handled natively by rxing's finder-pattern canonical
/// reordering (`detector.rs:139-263`), so no explicit rotation-retry flag
/// is exposed — empirical testing showed the (now-removed) `try_rotate`
/// loop produced zero additional decodes on every fixture in the test
/// suite. Cameras held sideways / upside-down decode identically to
/// upright captures.
///
/// Returns a JS `Array` of `Uint8Array`, one per detected symbol (empty when
/// none are found). Returns `Err` only for invalid input (e.g. mismatched
/// buffer length). Callers that need a string must decode the bytes
/// themselves (e.g. `new TextDecoder().decode(bytes)`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)] // wasm-bindgen call shape; packing into a struct hurts the JS side
pub fn read_qr_codes_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
    binarizer_fallback: bool,
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
        binarizer_fallback,
        max_number_of_symbols,
    );

    let out = js_sys::Array::new_with_length(payloads.len() as u32);
    for (i, bytes) in payloads.into_iter().enumerate() {
        out.set(i as u32, js_sys::Uint8Array::from(bytes.as_slice()).into());
    }
    Ok(out)
}
