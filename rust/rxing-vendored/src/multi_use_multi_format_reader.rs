use std::collections::HashSet;

use crate::DecodeHints;
use crate::common::Result;
use crate::qrcode::QRCodeReader;
use crate::qrcode::cpp_port::QrReader;
use crate::{BarcodeFormat, Binarizer, BinaryBitmap, Exceptions, RXingResult, Reader};

/// QR-only `MultiUseMultiFormatReader`. Trimmed for `rxing-wasm`.
#[derive(Default)]
pub struct MultiUseMultiFormatReader {
    hints: DecodeHints,
    possible_formats: HashSet<BarcodeFormat>,
    qr_code_reader: QRCodeReader,
    cpp_qrcode_reader: QrReader,
}

impl Reader for MultiUseMultiFormatReader {
    fn decode<B: Binarizer>(&mut self, image: &mut BinaryBitmap<B>) -> Result<RXingResult> {
        self.set_hints(&DecodeHints::default());
        self.decode_internal(image)
    }

    fn decode_with_hints<B: Binarizer>(
        &mut self,
        image: &mut BinaryBitmap<B>,
        hints: &DecodeHints,
    ) -> Result<RXingResult> {
        self.set_hints(hints);
        self.decode_internal(image)
    }

    fn reset(&mut self) {
        self.qr_code_reader.reset();
        self.cpp_qrcode_reader.reset();
    }
}

impl MultiUseMultiFormatReader {
    pub fn decode_with_state<B: Binarizer>(
        &mut self,
        image: &mut BinaryBitmap<B>,
    ) -> Result<RXingResult> {
        if self.possible_formats.is_empty() {
            self.set_hints(&DecodeHints::default());
        }
        self.decode_internal(image)
    }

    pub fn set_hints(&mut self, hints: &DecodeHints) {
        self.hints.clone_from(hints);
        self.possible_formats = if let Some(formats) = &hints.PossibleFormats {
            formats.clone()
        } else {
            HashSet::new()
        };
    }

    pub fn decode_internal<B: Binarizer>(
        &mut self,
        image: &mut BinaryBitmap<B>,
    ) -> Result<RXingResult> {
        let res = self.decode_formats(image);
        if res.is_ok() {
            return res;
        }
        if matches!(self.hints.AlsoInverted, Some(true)) {
            image.get_black_matrix_mut().flip_self();
            let res = self.decode_formats(image);
            if let Ok(mut r) = res {
                r.putMetadata(
                    crate::RXingResultMetadataType::IS_INVERTED,
                    crate::RXingResultMetadataValue::IsInverted(true),
                );
                return Ok(r);
            }
        }
        Err(Exceptions::NOT_FOUND)
    }

    fn decode_formats<B: Binarizer>(&mut self, image: &mut BinaryBitmap<B>) -> Result<RXingResult> {
        if !self.possible_formats.is_empty() {
            for possible_format in self.possible_formats.iter() {
                let res = match possible_format {
                    BarcodeFormat::QR_CODE => {
                        let a = self.cpp_qrcode_reader.decode_with_hints(image, &self.hints);
                        if a.is_ok() {
                            a
                        } else {
                            self.qr_code_reader.decode_with_hints(image, &self.hints)
                        }
                    }
                    BarcodeFormat::MICRO_QR_CODE
                    | BarcodeFormat::RECTANGULAR_MICRO_QR_CODE => {
                        self.cpp_qrcode_reader.decode_with_hints(image, &self.hints)
                    }
                    _ => Err(Exceptions::UNSUPPORTED_OPERATION),
                };
                if res.is_ok() {
                    return res;
                }
            }
        } else {
            if let Ok(res) = self.cpp_qrcode_reader.decode_with_hints(image, &self.hints) {
                return Ok(res);
            }
            if let Ok(res) = self.qr_code_reader.decode_with_hints(image, &self.hints) {
                return Ok(res);
            }
        }

        Err(Exceptions::NOT_FOUND)
    }
}
