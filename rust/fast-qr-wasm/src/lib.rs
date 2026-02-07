use fast_qr::qr::QRCodeError;
use fast_qr::{ECL, Mode, QRBuilder};
use png::{BitDepth, ColorType, Encoder};
use wasm_bindgen::prelude::*;

fn parse_ecl(ecl: &str) -> Result<ECL, String> {
    match ecl.trim().to_ascii_uppercase().as_str() {
        "L" => Ok(ECL::L),
        "M" => Ok(ECL::M),
        "Q" => Ok(ECL::Q),
        "H" => Ok(ECL::H),
        _ => Err("Invalid error correction level. Expected one of: L, M, Q, H".to_string()),
    }
}

fn map_qr_error(error: QRCodeError) -> String {
    match error {
        QRCodeError::EncodedData => String::from(
            "Data too big to be encoded in a single QR code at the selected settings",
        ),
        QRCodeError::SpecifiedVersion => {
            String::from("Specified QR version is too low for the provided data")
        }
    }
}

fn map_png_error(error: png::EncodingError) -> String {
    format!("Failed to encode QR PNG: {error}")
}

fn generate_qr_png_internal(
    data: &[u8],
    width: u32,
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
) -> Result<Vec<u8>, String> {
    if width == 0 {
        return Err("Width must be greater than 0".to_string());
    }

    let parsed_ecl = parse_ecl(ecl)?;

    let mut qr_builder = QRBuilder::new(data.to_vec());
    qr_builder.ecl(parsed_ecl);

    if force_byte_mode {
        qr_builder.mode(Mode::Byte);
    }

    let qrcode = qr_builder.build().map_err(map_qr_error)?;
    let qr_size = qrcode.size as u32;
    let margin_modules = margin
        .checked_mul(2)
        .ok_or_else(|| "Margin is too large".to_string())?;
    let module_count = qr_size
        .checked_add(margin_modules)
        .ok_or_else(|| "QR module count overflow".to_string())?;

    if module_count == 0 {
        return Err("Invalid QR module size".to_string());
    }

    // Compute pixel size per module, then size the canvas to fit exactly (no wasted padding).
    let pixel_size = width / module_count;
    if pixel_size == 0 {
        return Err("QR cannot fit in target width. Increase width or reduce margin.".to_string());
    }

    let actual_size = module_count
        .checked_mul(pixel_size)
        .ok_or_else(|| "Rendered QR size overflow".to_string())?;

    let mut pixels = vec![255u8; (actual_size * actual_size) as usize];

    for row in 0..qr_size {
        for col in 0..qr_size {
            let idx = (row * qr_size + col) as usize;
            let is_dark = qrcode.data[idx].value();

            if !is_dark {
                continue;
            }

            let start_x = (margin + col) * pixel_size;
            let start_y = (margin + row) * pixel_size;
            let end_x = start_x + pixel_size;
            let end_y = start_y + pixel_size;

            if end_x > actual_size || end_y > actual_size {
                return Err("Computed module bounds exceed target canvas".to_string());
            }

            for y in start_y..end_y {
                for x in start_x..end_x {
                    let pixel_index = (y * actual_size + x) as usize;
                    pixels[pixel_index] = 0;
                }
            }
        }
    }

    let mut png_data = Vec::new();
    let mut encoder = Encoder::new(&mut png_data, actual_size, actual_size);
    encoder.set_color(ColorType::Grayscale);
    encoder.set_depth(BitDepth::Eight);

    let mut writer = encoder.write_header().map_err(map_png_error)?;
    writer.write_image_data(&pixels).map_err(map_png_error)?;

    drop(writer);
    Ok(png_data)
}

/// Generate a PNG QR image from raw bytes.
///
/// - `data`: input payload bytes
/// - `width`: target image width in pixels
/// - `margin`: quiet zone in module units
/// - `ecl`: one of "L", "M", "Q", "H"
/// - `force_byte_mode`: when true, forces QR Byte mode for binary-safe payload encoding
#[wasm_bindgen]
pub fn generate_qr_png(
    data: &[u8],
    width: u32,
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
) -> Result<Vec<u8>, JsValue> {
    generate_qr_png_internal(data, width, margin, ecl, force_byte_mode)
        .map_err(|message| JsValue::from_str(&message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    fn decode_dimensions(png_bytes: &[u8]) -> (u32, u32) {
        let decoder = png::Decoder::new(Cursor::new(png_bytes));
        let reader = decoder.read_info().expect("PNG should decode");
        let info = reader.info();
        (info.width, info.height)
    }

    #[test]
    fn generates_valid_png_for_text_payload() {
        let png = generate_qr_png_internal(b"https://example.com", 300, 4, "M", false)
            .expect("QR generation should succeed");

        assert!(png.len() > 8, "PNG should not be empty");
        assert_eq!(&png[0..8], PNG_SIGNATURE, "PNG signature mismatch");

        let (width, height) = decode_dimensions(&png);
        // Output is pixel_size * module_count which is <= requested width
        assert!(width <= 300, "Output width should not exceed requested width");
        assert_eq!(width, height, "Output should be square");
        assert!(width > 0, "Output should have non-zero dimensions");
    }

    #[test]
    fn generates_valid_png_for_binary_payload_in_byte_mode() {
        let binary_payload = [0x00, 0xFF, 0x80, 0x41, 0x42, 0x43, 0x7F, 0x10];
        let png = generate_qr_png_internal(&binary_payload, 256, 2, "Q", true)
            .expect("Binary QR generation should succeed");

        assert!(png.len() > 8, "PNG should not be empty");
        assert_eq!(&png[0..8], PNG_SIGNATURE, "PNG signature mismatch");

        let (width, height) = decode_dimensions(&png);
        assert!(width <= 256, "Output width should not exceed requested width");
        assert_eq!(width, height, "Output should be square");
        assert!(width > 0, "Output should have non-zero dimensions");
    }

    #[test]
    fn rejects_zero_width() {
        let err =
            generate_qr_png_internal(b"hello", 0, 4, "M", false).expect_err("width=0 should fail");
        assert!(err.contains("Width must be greater than 0"));
    }

    #[test]
    fn rejects_invalid_ecl_value() {
        let err = generate_qr_png_internal(b"hello", 256, 4, "INVALID", false)
            .expect_err("invalid ECL should fail");
        assert!(err.contains("Invalid error correction level"));
    }

    #[test]
    fn rejects_when_qr_cannot_fit_target_width() {
        // Version 1 QR + default quiet zone cannot fit into width 8.
        let err = generate_qr_png_internal(b"a", 8, 4, "M", false)
            .expect_err("width too small should fail");
        assert!(err.contains("QR cannot fit in target width"));
    }

    #[test]
    fn rejects_margin_overflow() {
        let err = generate_qr_png_internal(b"a", 300, u32::MAX, "M", false)
            .expect_err("margin overflow should fail");
        assert!(err.contains("Margin is too large"));
    }
}
