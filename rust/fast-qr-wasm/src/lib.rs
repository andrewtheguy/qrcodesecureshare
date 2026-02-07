use fast_qr::qr::QRCodeError;
use fast_qr::{ECL, Mode, QRBuilder};
use png::{BitDepth, ColorType, Encoder};
use wasm_bindgen::prelude::*;

fn parse_ecl(ecl: &str) -> Result<ECL, JsValue> {
    match ecl.trim().to_ascii_uppercase().as_str() {
        "L" => Ok(ECL::L),
        "M" => Ok(ECL::M),
        "Q" => Ok(ECL::Q),
        "H" => Ok(ECL::H),
        _ => Err(JsValue::from_str(
            "Invalid error correction level. Expected one of: L, M, Q, H",
        )),
    }
}

fn map_qr_error(error: QRCodeError) -> JsValue {
    match error {
        QRCodeError::EncodedData => JsValue::from_str(
            "Data too big to be encoded in a single QR code at the selected settings",
        ),
        QRCodeError::SpecifiedVersion => {
            JsValue::from_str("Specified QR version is too low for the provided data")
        }
    }
}

fn map_png_error(error: png::EncodingError) -> JsValue {
    JsValue::from_str(&format!("Failed to encode QR PNG: {error}"))
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
    if width == 0 {
        return Err(JsValue::from_str("Width must be greater than 0"));
    }

    let parsed_ecl = parse_ecl(ecl)?;

    let mut qr_builder = QRBuilder::new(data.to_vec());
    qr_builder.ecl(parsed_ecl);

    if force_byte_mode {
        qr_builder.mode(Mode::Byte);
    }

    let qrcode = qr_builder.build().map_err(map_qr_error)?;
    let qr_size = qrcode.size as u32;
    let module_count = qr_size + (margin * 2);

    if module_count == 0 {
        return Err(JsValue::from_str("Invalid QR module size"));
    }

    let pixel_size = (width / module_count).max(1);
    let rendered_size = module_count * pixel_size;
    let offset = (width.saturating_sub(rendered_size)) / 2;

    let mut pixels = vec![255u8; (width * width) as usize];

    for row in 0..qr_size {
        for col in 0..qr_size {
            let idx = (row * qr_size + col) as usize;
            let is_dark = qrcode.data[idx].value();

            if !is_dark {
                continue;
            }

            let start_x = offset + (margin + col) * pixel_size;
            let start_y = offset + (margin + row) * pixel_size;

            for y in start_y..(start_y + pixel_size) {
                for x in start_x..(start_x + pixel_size) {
                    let pixel_index = (y * width + x) as usize;
                    pixels[pixel_index] = 0;
                }
            }
        }
    }

    let mut png_data = Vec::new();
    let mut encoder = Encoder::new(&mut png_data, width, width);
    encoder.set_color(ColorType::Grayscale);
    encoder.set_depth(BitDepth::Eight);

    let mut writer = encoder.write_header().map_err(map_png_error)?;
    writer.write_image_data(&pixels).map_err(map_png_error)?;

    drop(writer);
    Ok(png_data)
}
