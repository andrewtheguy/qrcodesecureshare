/*
* Copyright 2016 Nu-book Inc.
* Copyright 2016 ZXing authors
* Copyright 2022 Axel Waggershauser
*/
// SPDX-License-Identifier: Apache-2.0

use crate::{
    BarcodeFormat, DecodeHints, RXingResult,
    common::{DetectorRXingResult, cpp_essentials::ConcentricPattern},
};

use super::{
    decoder::Decode,
    detector::{FindFinderPatterns, GenerateFinderPatternSets, SampleMQR, SampleQR, SampleRMQR},
};

#[derive(Default)]
pub struct QrReader;

impl QrReader {
    /// Decode every QR / Micro QR / rMQR symbol found in `image`.
    ///
    /// `count` caps the number of results; pass `0` for unlimited.
    pub fn decode_set_number_with_hints<B: crate::Binarizer>(
        &self,
        image: &mut crate::BinaryBitmap<B>,
        hints: &DecodeHints,
        count: u32,
    ) -> crate::common::Result<Vec<RXingResult>> {
        let binImg = image.get_black_matrix()?;
        let maxSymbols = count;
        let try_harder = hints.TryHarder.unwrap_or(false);

        let mut allFPs = FindFinderPatterns(binImg, try_harder);

        let mut usedFPs: Vec<ConcentricPattern> = Vec::new();
        let mut results: Vec<RXingResult> = Vec::new();

        let (check_qr, check_mqr, check_rmqr) = if let Some(formats) = &hints.PossibleFormats {
            (
                formats.contains(&BarcodeFormat::QR_CODE),
                formats.contains(&BarcodeFormat::MICRO_QR_CODE),
                formats.contains(&BarcodeFormat::RECTANGULAR_MICRO_QR_CODE),
            )
        } else {
            (true, true, true)
        };

        if check_qr {
            let allFPSets = GenerateFinderPatternSets(&mut allFPs);
            for fpSet in allFPSets {
                if usedFPs.contains(&fpSet.bl)
                    || usedFPs.contains(&fpSet.tl)
                    || usedFPs.contains(&fpSet.tr)
                {
                    continue;
                }

                let detectorResult = SampleQR(binImg, &fpSet);
                if let Ok(detectorResult) = detectorResult {
                    let decoderResult = Decode(detectorResult.getBits());
                    let position = detectorResult.getPoints();
                    if let Ok(decoderResult) = decoderResult {
                        if decoderResult.isValid() {
                            usedFPs.push(fpSet.bl);
                            usedFPs.push(fpSet.tl);
                            usedFPs.push(fpSet.tr);
                        }

                        if decoderResult.isValid() {
                            results.push(RXingResult::with_decoder_result_bytes_only(
                                decoderResult,
                                position,
                                BarcodeFormat::QR_CODE,
                            ));

                            if maxSymbols != 0 && (results.len() as u32) == maxSymbols {
                                break;
                            }
                        }
                    }
                }
            }
        }
        if check_mqr && !(maxSymbols != 0 && (results.len() as u32) == maxSymbols) {
            for fp in &allFPs {
                if usedFPs.contains(fp) {
                    continue;
                }

                let detectorResult = SampleMQR(binImg, *fp);
                if let Ok(detectorResult) = detectorResult {
                    let decoderResult = Decode(detectorResult.getBits());
                    let position = detectorResult.getPoints();
                    if let Ok(decoderResult) = decoderResult
                        && decoderResult.isValid()
                    {
                        results.push(RXingResult::with_decoder_result_bytes_only(
                            decoderResult,
                            position,
                            BarcodeFormat::MICRO_QR_CODE,
                        ));

                        if maxSymbols != 0 && (results.len() as u32) == maxSymbols {
                            break;
                        }
                    }
                }
            }
        }
        if check_rmqr && !(maxSymbols != 0 && (results.len() as u32) == maxSymbols) {
            for fp in &allFPs {
                if usedFPs.contains(fp) {
                    continue;
                }

                let detectorResult = SampleRMQR(binImg, *fp);
                if let Ok(detectorResult) = detectorResult {
                    let decoderResult = Decode(detectorResult.getBits());
                    let position = detectorResult.getPoints();
                    if let Ok(decoderResult) = decoderResult
                        && decoderResult.isValid()
                    {
                        results.push(RXingResult::with_decoder_result_bytes_only(
                            decoderResult,
                            position,
                            BarcodeFormat::RECTANGULAR_MICRO_QR_CODE,
                        ));

                        if maxSymbols != 0 && (results.len() as u32) == maxSymbols {
                            break;
                        }
                    }
                }
            }
        }

        Ok(results)
    }
}
