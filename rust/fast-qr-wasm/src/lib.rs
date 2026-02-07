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
    let margin_modules = margin
        .checked_mul(2)
        .ok_or_else(|| JsValue::from_str("Margin is too large"))?;
    let module_count = qr_size
        .checked_add(margin_modules)
        .ok_or_else(|| JsValue::from_str("QR module count overflow"))?;

    if module_count == 0 {
        return Err(JsValue::from_str("Invalid QR module size"));
    }

    // Fail fast if the full QR (including margins) cannot fit the requested output width.
    let pixel_size = width / module_count;
    if pixel_size == 0 {
        return Err(JsValue::from_str(
            "QR cannot fit in target width. Increase width or reduce margin.",
        ));
    }

    let rendered_size = module_count
        .checked_mul(pixel_size)
        .ok_or_else(|| JsValue::from_str("Rendered QR size overflow"))?;
    if rendered_size > width {
        return Err(JsValue::from_str(
            "Computed QR render size exceeds target width",
        ));
    }

    let offset = (width - rendered_size) / 2;
    let render_end = offset
        .checked_add(rendered_size)
        .ok_or_else(|| JsValue::from_str("Render bounds overflow"))?;
    if render_end > width {
        return Err(JsValue::from_str(
            "Computed render bounds exceed target canvas",
        ));
    }

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
            let end_x = start_x + pixel_size;
            let end_y = start_y + pixel_size;

            if end_x > width || end_y > width {
                return Err(JsValue::from_str(
                    "Computed module bounds exceed target canvas",
                ));
            }

            for y in start_y..end_y {
                for x in start_x..end_x {
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
