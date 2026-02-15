use fast_qr::convert::svg::SvgBuilder;
use fast_qr::convert::Builder;
use fast_qr::qr::QRCodeError;
use fast_qr::{Mode, QRBuilder, QRCode, ECL};
use png::{BitDepth, ColorType, Encoder};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};
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
        QRCodeError::EncodedData => {
            String::from("Data too big to be encoded in a single QR code at the selected settings")
        }
        QRCodeError::SpecifiedVersion => {
            String::from("Specified QR version is too low for the provided data")
        }
    }
}

fn map_png_error(error: png::EncodingError) -> String {
    format!("Failed to encode QR PNG: {error}")
}

fn build_qrcode(data: &[u8], ecl: &str, force_byte_mode: bool) -> Result<QRCode, String> {
    let parsed_ecl = parse_ecl(ecl)?;

    let mut qr_builder = QRBuilder::new(data.to_vec());
    qr_builder.ecl(parsed_ecl);

    if force_byte_mode {
        qr_builder.mode(Mode::Byte);
    }

    qr_builder.build().map_err(map_qr_error)
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

    let qrcode = build_qrcode(data, ecl, force_byte_mode)?;
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

    let actual_size_usize =
        usize::try_from(actual_size).map_err(|_| "Rendered QR size overflow".to_string())?;
    let pixel_count = actual_size_usize
        .checked_mul(actual_size_usize)
        .ok_or_else(|| "Rendered QR size overflow".to_string())?;
    let mut pixels = vec![255u8; pixel_count];
    let qr_size_usize =
        usize::try_from(qr_size).map_err(|_| "QR module count overflow".to_string())?;

    for row in 0..qr_size {
        let row_usize = usize::try_from(row)
            .map_err(|_| "Computed module bounds exceed target canvas".to_string())?;
        for col in 0..qr_size {
            let col_usize = usize::try_from(col)
                .map_err(|_| "Computed module bounds exceed target canvas".to_string())?;
            let idx = row_usize
                .checked_mul(qr_size_usize)
                .and_then(|base| base.checked_add(col_usize))
                .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;
            let is_dark = qrcode.data[idx].value();

            if !is_dark {
                continue;
            }

            let start_x = margin
                .checked_add(col)
                .and_then(|value| value.checked_mul(pixel_size))
                .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;
            let start_y = margin
                .checked_add(row)
                .and_then(|value| value.checked_mul(pixel_size))
                .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;
            let end_x = start_x
                .checked_add(pixel_size)
                .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;
            let end_y = start_y
                .checked_add(pixel_size)
                .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;

            if end_x > actual_size || end_y > actual_size {
                return Err("Computed module bounds exceed target canvas".to_string());
            }

            for y in start_y..end_y {
                for x in start_x..end_x {
                    let pixel_index = usize::try_from(y)
                        .ok()
                        .and_then(|y| y.checked_mul(actual_size_usize))
                        .and_then(|base| usize::try_from(x).ok().and_then(|x| base.checked_add(x)))
                        .ok_or_else(|| "Computed module bounds exceed target canvas".to_string())?;
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

fn inject_svg_dimensions(
    svg: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String, String> {
    if width.is_none() && height.is_none() {
        return Ok(svg.to_string());
    }

    let mut reader = Reader::from_str(svg);
    let mut writer = Writer::new(Vec::new());

    let mut svg_tag_found = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) if !svg_tag_found && e.name().as_ref() == b"svg" => {
                svg_tag_found = true;
                let mut elem = BytesStart::from(e.name());
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| format!("SVG attribute error: {e}"))?;
                    let key = attr.key.as_ref();
                    if width.is_some() && key == b"width" {
                        continue;
                    }
                    if height.is_some() && key == b"height" {
                        continue;
                    }
                    elem.push_attribute(attr);
                }
                if let Some(w) = width {
                    elem.push_attribute(("width", w.to_string().as_str()));
                }
                if let Some(h) = height {
                    elem.push_attribute(("height", h.to_string().as_str()));
                }
                writer
                    .write_event(Event::Start(elem))
                    .map_err(|e| format!("SVG write error: {e}"))?;
            }
            Ok(Event::Eof) => break,
            Ok(e) => writer
                .write_event(e)
                .map_err(|e| format!("SVG write error: {e}"))?,
            Err(e) => return Err(format!("SVG parse error: {e}")),
        }
    }

    String::from_utf8(writer.into_inner()).map_err(|e| format!("SVG UTF-8 error: {e}"))
}

fn generate_qr_svg_internal(
    data: &[u8],
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
    svg_width: Option<u32>,
    svg_height: Option<u32>,
) -> Result<String, String> {
    let qrcode = build_qrcode(data, ecl, force_byte_mode)?;
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

    let margin_usize = usize::try_from(margin).map_err(|_| "Margin is too large".to_string())?;

    let mut svg_builder = SvgBuilder::default();
    svg_builder.margin(margin_usize);
    let svg = svg_builder.to_str(&qrcode);
    inject_svg_dimensions(&svg, svg_width, svg_height)
}

fn generate_qr_matrix_internal(
    data: &[u8],
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
) -> Result<Vec<u8>, String> {
    let qrcode = build_qrcode(data, ecl, force_byte_mode)?;
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
    if module_count > u16::MAX as u32 {
        return Err("QR module count exceeds supported range".to_string());
    }

    let module_count_usize =
        usize::try_from(module_count).map_err(|_| "QR module count overflow".to_string())?;
    let total_module_cells = module_count_usize
        .checked_mul(module_count_usize)
        .ok_or_else(|| "QR module matrix overflow".to_string())?;

    // Format:
    // [module_count_hi][module_count_lo][module_0][module_1]...
    // where module bytes are row-major, 0=light, 1=dark, including quiet-zone margin.
    let mut matrix = vec![0u8; 2 + total_module_cells];
    matrix[0] = ((module_count >> 8) & 0xFF) as u8;
    matrix[1] = (module_count & 0xFF) as u8;

    let qr_size_usize =
        usize::try_from(qr_size).map_err(|_| "QR module count overflow".to_string())?;
    let margin_usize = usize::try_from(margin).map_err(|_| "Margin is too large".to_string())?;

    for row in 0..qr_size_usize {
        for col in 0..qr_size_usize {
            let idx = row
                .checked_mul(qr_size_usize)
                .and_then(|base| base.checked_add(col))
                .ok_or_else(|| "QR module matrix overflow".to_string())?;
            if !qrcode.data[idx].value() {
                continue;
            }

            let matrix_row = row
                .checked_add(margin_usize)
                .ok_or_else(|| "QR module matrix overflow".to_string())?;
            let matrix_col = col
                .checked_add(margin_usize)
                .ok_or_else(|| "QR module matrix overflow".to_string())?;
            let matrix_idx = matrix_row
                .checked_mul(module_count_usize)
                .and_then(|base| base.checked_add(matrix_col))
                .and_then(|cell| cell.checked_add(2))
                .ok_or_else(|| "QR module matrix overflow".to_string())?;
            matrix[matrix_idx] = 1;
        }
    }

    Ok(matrix)
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

/// Generate an SVG QR image from raw bytes.
///
/// - `data`: input payload bytes
/// - `margin`: quiet zone in module units
/// - `ecl`: one of "L", "M", "Q", "H"
/// - `force_byte_mode`: when true, forces QR Byte mode for binary-safe payload encoding
/// - `svg_width`: optional explicit width attribute for the SVG element
/// - `svg_height`: optional explicit height attribute for the SVG element
#[wasm_bindgen]
pub fn generate_qr_svg(
    data: &[u8],
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
    svg_width: Option<u32>,
    svg_height: Option<u32>,
) -> Result<String, JsValue> {
    generate_qr_svg_internal(data, margin, ecl, force_byte_mode, svg_width, svg_height)
        .map_err(|message| JsValue::from_str(&message))
}

/// Generate a QR module matrix from raw bytes.
///
/// Returned bytes use this format:
/// - Byte 0-1: module count (u16, big-endian), including quiet-zone margin
/// - Remaining bytes: row-major module values where 0=light and 1=dark
#[wasm_bindgen]
pub fn generate_qr_matrix(
    data: &[u8],
    margin: u32,
    ecl: &str,
    force_byte_mode: bool,
) -> Result<Vec<u8>, JsValue> {
    generate_qr_matrix_internal(data, margin, ecl, force_byte_mode)
        .map_err(|message| JsValue::from_str(&message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    struct DecodedPng {
        width: u32,
        height: u32,
        color_type: ColorType,
        bit_depth: BitDepth,
        pixels: Vec<u8>,
    }

    struct RenderGeometry {
        qrcode: QRCode,
        qr_size: u32,
        module_count: u32,
        pixel_size: u32,
        actual_size: u32,
        margin: u32,
    }

    fn decode_png(png_bytes: &[u8]) -> DecodedPng {
        let decoder = png::Decoder::new(Cursor::new(png_bytes));
        let mut reader = decoder.read_info().expect("PNG should decode");
        let mut output_buffer = vec![0; reader.output_buffer_size()];
        let output = reader
            .next_frame(&mut output_buffer)
            .expect("PNG frame should decode");

        DecodedPng {
            width: output.width,
            height: output.height,
            color_type: output.color_type,
            bit_depth: output.bit_depth,
            pixels: output_buffer[..output.buffer_size()].to_vec(),
        }
    }

    fn build_render_geometry(
        payload: &[u8],
        width: u32,
        margin: u32,
        ecl: &str,
        force_byte_mode: bool,
    ) -> RenderGeometry {
        let qrcode = build_qrcode(payload, ecl, force_byte_mode).expect("QR build should succeed");
        let qr_size = qrcode.size as u32;
        let module_count = qr_size
            .checked_add(margin.checked_mul(2).expect("margin module overflow"))
            .expect("module count overflow");
        let pixel_size = width / module_count;
        let actual_size = module_count
            .checked_mul(pixel_size)
            .expect("rendered size overflow");

        RenderGeometry {
            qrcode,
            qr_size,
            module_count,
            pixel_size,
            actual_size,
            margin,
        }
    }

    fn pixel_at(image: &DecodedPng, x: u32, y: u32) -> u8 {
        let width = usize::try_from(image.width).expect("width should fit usize");
        let x_usize = usize::try_from(x).expect("x should fit usize");
        let y_usize = usize::try_from(y).expect("y should fit usize");
        image.pixels[y_usize * width + x_usize]
    }

    fn assert_quiet_zone_white(image: &DecodedPng, geometry: &RenderGeometry) {
        if geometry.margin == 0 {
            return;
        }

        let quiet_zone_pixels = geometry
            .margin
            .checked_mul(geometry.pixel_size)
            .expect("quiet zone pixel size overflow");

        for y in 0..image.height {
            for x in 0..image.width {
                let in_quiet_zone = x < quiet_zone_pixels
                    || x >= image.width - quiet_zone_pixels
                    || y < quiet_zone_pixels
                    || y >= image.height - quiet_zone_pixels;
                if in_quiet_zone {
                    assert_eq!(
                        pixel_at(image, x, y),
                        255,
                        "quiet zone pixel should be white at ({x}, {y})"
                    );
                }
            }
        }
    }

    fn assert_module_blocks_uniform(image: &DecodedPng, geometry: &RenderGeometry) {
        for module_row in 0..geometry.module_count {
            for module_col in 0..geometry.module_count {
                let start_x = module_col * geometry.pixel_size;
                let start_y = module_row * geometry.pixel_size;
                let expected = pixel_at(image, start_x, start_y);

                for y in start_y..(start_y + geometry.pixel_size) {
                    for x in start_x..(start_x + geometry.pixel_size) {
                        assert_eq!(
                            pixel_at(image, x, y),
                            expected,
                            "module block ({module_row}, {module_col}) contains mixed pixels"
                        );
                    }
                }
            }
        }
    }

    fn assert_qr_region_matches_matrix(image: &DecodedPng, geometry: &RenderGeometry) {
        let qr_size_usize = usize::try_from(geometry.qr_size).expect("qr_size should fit usize");

        for row in 0..geometry.qr_size {
            for col in 0..geometry.qr_size {
                let row_usize = usize::try_from(row).expect("row should fit usize");
                let col_usize = usize::try_from(col).expect("col should fit usize");
                let idx = row_usize
                    .checked_mul(qr_size_usize)
                    .and_then(|base| base.checked_add(col_usize))
                    .expect("index should be in range");
                let expected_dark = geometry.qrcode.data[idx].value();

                let module_x = (col + geometry.margin) * geometry.pixel_size;
                let module_y = (row + geometry.margin) * geometry.pixel_size;
                let actual = pixel_at(image, module_x, module_y);
                let expected_pixel = if expected_dark { 0 } else { 255 };

                assert_eq!(
                    actual, expected_pixel,
                    "module mismatch at row {row}, col {col}"
                );
            }
        }
    }

    fn extract_qr_module_pattern(image: &DecodedPng, geometry: &RenderGeometry) -> Vec<bool> {
        let mut pattern = Vec::with_capacity(
            usize::try_from(
                geometry
                    .qr_size
                    .checked_mul(geometry.qr_size)
                    .expect("area overflow"),
            )
            .expect("pattern size should fit usize"),
        );

        for row in 0..geometry.qr_size {
            for col in 0..geometry.qr_size {
                let module_x = (col + geometry.margin) * geometry.pixel_size;
                let module_y = (row + geometry.margin) * geometry.pixel_size;
                pattern.push(pixel_at(image, module_x, module_y) == 0);
            }
        }

        pattern
    }

    fn assert_png_raster_invariants(
        png_bytes: &[u8],
        payload: &[u8],
        width: u32,
        margin: u32,
        ecl: &str,
        force_byte_mode: bool,
    ) -> (DecodedPng, RenderGeometry) {
        let image = decode_png(png_bytes);
        let geometry = build_render_geometry(payload, width, margin, ecl, force_byte_mode);

        assert_eq!(image.width, image.height, "PNG output should be square");
        assert_eq!(
            image.width, geometry.actual_size,
            "PNG dimensions should match computed render geometry"
        );
        assert_eq!(
            image.color_type,
            ColorType::Grayscale,
            "PNG should be grayscale for deterministic binary module rendering"
        );
        assert_eq!(
            image.bit_depth,
            BitDepth::Eight,
            "PNG should use 8-bit grayscale pixels"
        );

        let expected_pixels = usize::try_from(image.width)
            .expect("width should fit usize")
            .checked_mul(usize::try_from(image.height).expect("height should fit usize"))
            .expect("pixel count overflow");
        assert_eq!(
            image.pixels.len(),
            expected_pixels,
            "PNG decoded pixel buffer size should match dimensions"
        );

        assert!(
            image.pixels.iter().all(|&value| value == 0 || value == 255),
            "PNG should only contain binary grayscale values (0 or 255)"
        );

        assert_quiet_zone_white(&image, &geometry);
        assert_module_blocks_uniform(&image, &geometry);
        assert_qr_region_matches_matrix(&image, &geometry);

        (image, geometry)
    }

    fn svg_viewbox_size(svg: &str) -> u32 {
        let marker = r#"viewBox=""#;
        let start = svg
            .find(marker)
            .expect("SVG is missing `viewBox` attribute")
            + marker.len();
        let rest = &svg[start..];
        let end = rest
            .find('"')
            .expect("SVG has malformed `viewBox` attribute");
        let parts: Vec<&str> = rest[..end].split_whitespace().collect();

        assert_eq!(parts.len(), 4, "viewBox should contain four values");
        assert_eq!(parts[0], "0", "viewBox min-x should be 0");
        assert_eq!(parts[1], "0", "viewBox min-y should be 0");
        assert_eq!(parts[2], parts[3], "viewBox should be square");

        parts[2]
            .parse::<u32>()
            .expect("viewBox size should be an integer")
    }

    fn assert_valid_svg(svg: &str) {
        assert!(svg.starts_with("<svg "), "SVG should begin with <svg");
        assert!(
            svg.contains(r#"xmlns="http://www.w3.org/2000/svg""#),
            "SVG namespace should be present"
        );
        assert!(
            svg.contains(r#"viewBox="0 0 "#),
            "SVG viewBox should be present"
        );
        assert!(
            svg.contains(r#"<path d=""#),
            "SVG should contain QR path data"
        );
        assert!(svg.ends_with("</svg>"), "SVG should be closed");
        assert!(svg_viewbox_size(svg) > 0, "SVG viewBox should be non-zero");
    }

    fn matrix_module_count(matrix: &[u8]) -> u32 {
        assert!(
            matrix.len() >= 2,
            "Matrix output should include a 2-byte module count header"
        );
        u16::from_be_bytes([matrix[0], matrix[1]]) as u32
    }

    fn matrix_module_at(matrix: &[u8], module_count: u32, row: u32, col: u32) -> u8 {
        let module_count_usize =
            usize::try_from(module_count).expect("module count should fit usize");
        let row_usize = usize::try_from(row).expect("row should fit usize");
        let col_usize = usize::try_from(col).expect("col should fit usize");
        let index = row_usize
            .checked_mul(module_count_usize)
            .and_then(|base| base.checked_add(col_usize))
            .and_then(|base| base.checked_add(2))
            .expect("matrix index should be in range");
        matrix[index]
    }

    fn assert_matrix_invariants(
        matrix: &[u8],
        payload: &[u8],
        margin: u32,
        ecl: &str,
        force_byte_mode: bool,
    ) -> u32 {
        let qrcode = build_qrcode(payload, ecl, force_byte_mode).expect("QR build should succeed");
        let qr_size = qrcode.size as u32;
        let module_count = qr_size
            .checked_add(margin.checked_mul(2).expect("margin module overflow"))
            .expect("module count overflow");
        let module_count_u16 = u16::try_from(module_count).expect("module count should fit u16");
        let module_count_usize =
            usize::try_from(module_count).expect("module count should fit usize");
        let qr_size_usize = usize::try_from(qr_size).expect("qr_size should fit usize");
        let qr_limit = margin
            .checked_add(qr_size)
            .expect("margin + qr_size should not overflow");

        assert_eq!(
            matrix[0],
            ((module_count_u16 >> 8) & 0xFF) as u8,
            "high byte should encode module count in big-endian format"
        );
        assert_eq!(
            matrix[1],
            (module_count_u16 & 0xFF) as u8,
            "low byte should encode module count in big-endian format"
        );
        assert_eq!(
            matrix_module_count(matrix),
            module_count,
            "matrix header should encode module count"
        );

        let expected_len = module_count_usize
            .checked_mul(module_count_usize)
            .and_then(|cells| cells.checked_add(2))
            .expect("matrix length overflow");
        assert_eq!(
            matrix.len(),
            expected_len,
            "matrix length should equal header + module_count^2"
        );

        assert!(
            matrix[2..].iter().all(|&cell| cell == 0 || cell == 1),
            "matrix should only contain binary module values"
        );

        for row in 0..module_count {
            for col in 0..module_count {
                let row_usize = usize::try_from(row).expect("row should fit usize");
                let col_usize = usize::try_from(col).expect("col should fit usize");
                let matrix_idx = row_usize
                    .checked_mul(module_count_usize)
                    .and_then(|base| base.checked_add(col_usize))
                    .and_then(|base| base.checked_add(2))
                    .expect("matrix index should be in range");

                let expected = if row < margin || row >= qr_limit || col < margin || col >= qr_limit
                {
                    0
                } else {
                    let qr_row = row - margin;
                    let qr_col = col - margin;
                    let qr_row_usize = usize::try_from(qr_row).expect("qr row should fit usize");
                    let qr_col_usize = usize::try_from(qr_col).expect("qr col should fit usize");
                    let qr_idx = qr_row_usize
                        .checked_mul(qr_size_usize)
                        .and_then(|base| base.checked_add(qr_col_usize))
                        .expect("QR index should be in range");
                    if qrcode.data[qr_idx].value() {
                        1
                    } else {
                        0
                    }
                };

                assert_eq!(
                    matrix[matrix_idx], expected,
                    "module mismatch at row {row}, col {col}"
                );
            }
        }

        module_count
    }

    #[test]
    fn generates_valid_png_for_text_payload() {
        let payload = b"https://example.com";
        let png = generate_qr_png_internal(payload, 300, 4, "M", false)
            .expect("QR generation should succeed");

        assert!(png.len() > 8, "PNG should not be empty");
        assert_eq!(&png[0..8], PNG_SIGNATURE, "PNG signature mismatch");
        assert_png_raster_invariants(&png, payload, 300, 4, "M", false);
    }

    #[test]
    fn generates_valid_png_for_binary_payload_in_byte_mode() {
        let payload = [0x00, 0xFF, 0x80, 0x41, 0x42, 0x43, 0x7F, 0x10];
        let png = generate_qr_png_internal(&payload, 256, 2, "Q", true)
            .expect("Binary QR generation should succeed");

        assert!(png.len() > 8, "PNG should not be empty");
        assert_eq!(&png[0..8], PNG_SIGNATURE, "PNG signature mismatch");
        assert_png_raster_invariants(&png, &payload, 256, 2, "Q", true);
    }

    #[test]
    fn png_margin_changes_border_without_changing_qr_pattern() {
        let payload = b"png-margin-invariant";

        let png_no_margin =
            generate_qr_png_internal(payload, 300, 0, "M", false).expect("margin 0 should work");
        let png_margin_4 =
            generate_qr_png_internal(payload, 300, 4, "M", false).expect("margin 4 should work");

        let (image_no_margin, geometry_no_margin) =
            assert_png_raster_invariants(&png_no_margin, payload, 300, 0, "M", false);
        let (image_margin_4, geometry_margin_4) =
            assert_png_raster_invariants(&png_margin_4, payload, 300, 4, "M", false);

        let pattern_no_margin = extract_qr_module_pattern(&image_no_margin, &geometry_no_margin);
        let pattern_margin_4 = extract_qr_module_pattern(&image_margin_4, &geometry_margin_4);

        assert_eq!(
            pattern_no_margin, pattern_margin_4,
            "Adding margin should not change the underlying QR module pattern"
        );
    }

    #[test]
    fn png_width_scaling_preserves_module_pattern() {
        let payload = b"png-width-invariant";

        let png_narrow = generate_qr_png_internal(payload, 300, 4, "Q", false)
            .expect("narrow width should work");
        let png_wide =
            generate_qr_png_internal(payload, 500, 4, "Q", false).expect("wide width should work");

        let (image_narrow, geometry_narrow) =
            assert_png_raster_invariants(&png_narrow, payload, 300, 4, "Q", false);
        let (image_wide, geometry_wide) =
            assert_png_raster_invariants(&png_wide, payload, 500, 4, "Q", false);

        assert!(
            image_wide.width >= image_narrow.width,
            "Increasing width should not reduce output size"
        );
        assert!(
            geometry_wide.pixel_size >= geometry_narrow.pixel_size,
            "Increasing width should keep or increase module pixel size"
        );

        let pattern_narrow = extract_qr_module_pattern(&image_narrow, &geometry_narrow);
        let pattern_wide = extract_qr_module_pattern(&image_wide, &geometry_wide);

        assert_eq!(
            pattern_narrow, pattern_wide,
            "Changing width should not change the underlying QR module pattern"
        );
    }

    #[test]
    fn generates_valid_svg_for_text_payload() {
        let svg = generate_qr_svg_internal(b"https://example.com", 4, "M", false, None, None)
            .expect("SVG generation should succeed");
        assert_valid_svg(&svg);
    }

    #[test]
    fn generates_valid_svg_for_binary_payload_in_byte_mode() {
        let binary_payload = [0x00, 0xFF, 0x80, 0x41, 0x42, 0x43, 0x7F, 0x10];
        let svg = generate_qr_svg_internal(&binary_payload, 2, "Q", true, None, None)
            .expect("Binary SVG generation should succeed");
        assert_valid_svg(&svg);
    }

    #[test]
    fn svg_margin_changes_viewbox_size() {
        let no_margin = generate_qr_svg_internal(b"margin-check", 0, "M", false, None, None)
            .expect("SVG generation without margin should succeed");
        let with_margin = generate_qr_svg_internal(b"margin-check", 4, "M", false, None, None)
            .expect("SVG generation with margin should succeed");

        assert!(
            svg_viewbox_size(&with_margin) > svg_viewbox_size(&no_margin),
            "SVG viewBox should grow when margin increases"
        );
    }

    #[test]
    fn generates_valid_matrix_for_text_payload() {
        let payload = b"https://example.com";
        let matrix = generate_qr_matrix_internal(payload, 4, "M", false)
            .expect("Matrix generation should succeed");

        assert_matrix_invariants(&matrix, payload, 4, "M", false);
    }

    #[test]
    fn generates_valid_matrix_for_binary_payload_in_byte_mode() {
        let payload = [0x00, 0xFF, 0x80, 0x41, 0x42, 0x43, 0x7F, 0x10];
        let matrix = generate_qr_matrix_internal(&payload, 2, "Q", true)
            .expect("Binary matrix generation should succeed");

        assert_matrix_invariants(&matrix, &payload, 2, "Q", true);
    }

    #[test]
    fn matrix_margin_changes_module_count_and_offsets_qr_pattern() {
        let payload = b"matrix-margin-check";

        let matrix_no_margin = generate_qr_matrix_internal(payload, 0, "M", false)
            .expect("matrix generation with no margin should succeed");
        let matrix_margin_4 = generate_qr_matrix_internal(payload, 4, "M", false)
            .expect("matrix generation with margin should succeed");

        let no_margin_count = assert_matrix_invariants(&matrix_no_margin, payload, 0, "M", false);
        let margin_count = assert_matrix_invariants(&matrix_margin_4, payload, 4, "M", false);
        let quiet_zone = 4u32;

        assert_eq!(
            margin_count,
            no_margin_count + (quiet_zone * 2),
            "module count should include both margin sides"
        );

        for row in 0..margin_count {
            for col in 0..margin_count {
                let in_quiet_zone = row < quiet_zone
                    || row >= margin_count - quiet_zone
                    || col < quiet_zone
                    || col >= margin_count - quiet_zone;
                if in_quiet_zone {
                    assert_eq!(
                        matrix_module_at(&matrix_margin_4, margin_count, row, col),
                        0,
                        "quiet-zone module should be light at ({row}, {col})"
                    );
                }
            }
        }

        for row in 0..no_margin_count {
            for col in 0..no_margin_count {
                let row_with_margin = row
                    .checked_add(quiet_zone)
                    .expect("row offset should not overflow");
                let col_with_margin = col
                    .checked_add(quiet_zone)
                    .expect("col offset should not overflow");

                assert_eq!(
                    matrix_module_at(&matrix_no_margin, no_margin_count, row, col),
                    matrix_module_at(
                        &matrix_margin_4,
                        margin_count,
                        row_with_margin,
                        col_with_margin
                    ),
                    "margin should shift matrix content without changing QR modules"
                );
            }
        }
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
    fn rejects_invalid_ecl_value_for_svg() {
        let err = generate_qr_svg_internal(b"hello", 4, "INVALID", false, None, None)
            .expect_err("invalid ECL should fail");
        assert!(err.contains("Invalid error correction level"));
    }

    #[test]
    fn rejects_invalid_ecl_value_for_matrix() {
        let err = generate_qr_matrix_internal(b"hello", 4, "INVALID", false)
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

    #[test]
    fn rejects_margin_overflow_for_svg() {
        let err = generate_qr_svg_internal(b"a", u32::MAX, "M", false, None, None)
            .expect_err("margin overflow should fail");
        assert!(err.contains("Margin is too large"));
    }

    #[test]
    fn rejects_margin_overflow_for_matrix() {
        let err = generate_qr_matrix_internal(b"a", u32::MAX, "M", false)
            .expect_err("margin overflow should fail");
        assert!(err.contains("Margin is too large"));
    }

    fn extract_svg_tag(svg: &str) -> &str {
        let start = svg.find("<svg ").expect("SVG should start with <svg");
        let end = svg[start..].find('>').expect("SVG tag should close") + start + 1;
        &svg[start..end]
    }

    #[test]
    fn svg_with_both_width_and_height() {
        let svg =
            generate_qr_svg_internal(b"dimension-test", 4, "M", false, Some(200), Some(300))
                .expect("SVG with dimensions should succeed");
        assert_valid_svg(&svg);
        let tag = extract_svg_tag(&svg);
        assert!(
            tag.contains(r#"width="200""#),
            "SVG tag should contain width attribute"
        );
        assert!(
            tag.contains(r#"height="300""#),
            "SVG tag should contain height attribute"
        );
    }

    #[test]
    fn svg_with_only_width() {
        let svg = generate_qr_svg_internal(b"width-only", 4, "M", false, Some(150), None)
            .expect("SVG with width only should succeed");
        assert_valid_svg(&svg);
        let tag = extract_svg_tag(&svg);
        assert!(
            tag.contains(r#"width="150""#),
            "SVG tag should contain width attribute"
        );
        assert!(
            !tag.contains(r#"height=""#),
            "SVG tag should not contain height attribute"
        );
    }

    #[test]
    fn svg_with_only_height() {
        let svg = generate_qr_svg_internal(b"height-only", 4, "M", false, None, Some(250))
            .expect("SVG with height only should succeed");
        assert_valid_svg(&svg);
        let tag = extract_svg_tag(&svg);
        assert!(
            !tag.contains(r#"width=""#),
            "SVG tag should not contain width attribute"
        );
        assert!(
            tag.contains(r#"height="250""#),
            "SVG tag should contain height attribute"
        );
    }

    #[test]
    fn svg_without_dimensions() {
        let svg = generate_qr_svg_internal(b"no-dimensions", 4, "M", false, None, None)
            .expect("SVG without dimensions should succeed");
        assert_valid_svg(&svg);
        let tag = extract_svg_tag(&svg);
        assert!(
            !tag.contains(r#"width=""#),
            "SVG tag should not contain width attribute"
        );
        assert!(
            !tag.contains(r#"height=""#),
            "SVG tag should not contain height attribute"
        );
    }

    #[test]
    fn inject_svg_dimensions_replaces_existing_width_and_height() {
        let input = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 50 50"><path d="M0,0"/></svg>"#;
        let result = inject_svg_dimensions(input, Some(300), Some(300))
            .expect("inject_svg_dimensions should succeed");
        let tag = extract_svg_tag(&result);
        assert!(
            tag.contains(r#"width="300""#),
            "SVG tag should contain the new width: {tag}"
        );
        assert!(
            tag.contains(r#"height="300""#),
            "SVG tag should contain the new height: {tag}"
        );
        assert!(
            !tag.contains(r#"width="100""#),
            "SVG tag should not contain the old width: {tag}"
        );
        assert!(
            !tag.contains(r#"height="100""#),
            "SVG tag should not contain the old height: {tag}"
        );
    }
}
