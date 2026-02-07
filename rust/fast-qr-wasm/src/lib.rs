use fast_qr::convert::image::{ImageBuilder, ImageError};
use fast_qr::convert::Builder;
use fast_qr::qr::QRCodeError;
use fast_qr::{ECL, Mode, QRBuilder};
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

fn map_image_error(error: ImageError) -> JsValue {
    JsValue::from_str(&format!("Failed to render QR PNG: {error}"))
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

    let mut image_builder = ImageBuilder::default();
    image_builder.margin(margin as usize);
    image_builder.fit_width(width);

    image_builder.to_bytes(&qrcode).map_err(map_image_error)
}
