use std::collections::HashSet;

use rxing::{
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource, MultiFormatReader, Reader,
    RXingResultMetadataType, RXingResultMetadataValue,
    common::{GlobalHistogramBinarizer, HybridBinarizer},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DecodedQr {
    text: String,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedQr {
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.text.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

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

fn extract_bytes(text: &str, segments: Option<&Vec<Vec<u8>>>) -> Vec<u8> {
    if let Some(segments) = segments {
        let total: usize = segments.iter().map(|s| s.len()).sum();
        if total > 0 {
            let mut combined = Vec::with_capacity(total);
            for seg in segments {
                combined.extend_from_slice(seg);
            }
            return combined;
        }
    }
    text.as_bytes().to_vec()
}

fn decode_inner(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
) -> Option<DecodedQr> {
    let mut hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([BarcodeFormat::QR_CODE])),
        TryHarder: Some(try_harder),
        AlsoInverted: Some(try_invert),
        ..DecodeHints::default()
    };

    let source = Luma8LuminanceSource::new(luma, width, height);
    let mut reader = MultiFormatReader::default();

    let result = if use_hybrid_binarizer {
        let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
        reader.decode_with_hints(&mut bitmap, &mut hints)
    } else {
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        reader.decode_with_hints(&mut bitmap, &mut hints)
    };

    let result = result.ok()?;
    let byte_segments = result
        .getRXingResultMetadata()
        .get(&RXingResultMetadataType::BYTE_SEGMENTS)
        .and_then(|value| match value {
            RXingResultMetadataValue::ByteSegments(segments) => Some(segments),
            _ => None,
        });
    let bytes = extract_bytes(result.getText(), byte_segments);
    Some(DecodedQr {
        text: result.getText().to_string(),
        bytes,
    })
}

/// Decode a single QR code from raw RGBA pixels.
///
/// - `rgba`: row-major RGBA pixels, length must equal `width * height * 4`
/// - `try_harder`: spend more time looking for a barcode (maps to rxing's `TryHarder` hint)
/// - `try_invert`: also try an inverted image (maps to rxing's `AlsoInverted` hint)
/// - `use_hybrid_binarizer`: when true, use rxing's adaptive `HybridBinarizer`; when
///   false, use the faster but less robust `GlobalHistogramBinarizer`.
///
/// Returns `Ok(None)` when no QR code is found. Returns `Err` only for invalid input
/// (e.g. mismatched buffer length).
#[wasm_bindgen]
pub fn decode_qr_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    try_harder: bool,
    try_invert: bool,
    use_hybrid_binarizer: bool,
) -> Result<Option<DecodedQr>, JsValue> {
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
