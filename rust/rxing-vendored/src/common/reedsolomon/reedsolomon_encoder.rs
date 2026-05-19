/*
 * Copyright 2008 ZXing authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

use crate::Exceptions;
use crate::common::Result;

use super::{GenericGFPoly, GenericGFRef};

/**
 * <p>Implements Reed-Solomon encoding, as the name implies.</p>
 *
 * @author Sean Owen
 * @author William Rucklidge
 */
pub struct ReedSolomonEncoder {
    field: GenericGFRef,
    cachedGenerators: Vec<GenericGFPoly>,
}

impl ReedSolomonEncoder {
    pub fn new(field: GenericGFRef) -> Result<Self> {
        let n = field;
        Ok(Self {
            cachedGenerators: vec![GenericGFPoly::new(n, &[1])?],
            field: n,
        })
    }

    fn buildGenerator(&mut self, degree: usize) -> Result<&GenericGFPoly> {
        if degree >= self.cachedGenerators.len() {
            let mut lastGenerator = self
                .cachedGenerators
                .last()
                .ok_or_else(|| {
                    Exceptions::illegal_state_with(
                        "buildGenerator: cachedGenerators is empty",
                    )
                })?
                .clone();
            let cg_len = self.cachedGenerators.len();
            for d in cg_len..=degree {
                let factor = GenericGFPoly::new(
                    self.field,
                    &[
                        1,
                        self.field.exp(d as i32 - 1 + self.field.getGeneratorBase()),
                    ],
                )
                .map_err(|e| {
                    Exceptions::illegal_state_with(format!(
                        "buildGenerator: GenericGFPoly::new failed at degree {d}: {e:?}"
                    ))
                })?;
                let nextGenerator = lastGenerator.multiply(&factor).map_err(|e| {
                    Exceptions::illegal_state_with(format!(
                        "buildGenerator: multiply failed at degree {d}: {e:?}"
                    ))
                })?;
                self.cachedGenerators.push(nextGenerator.clone());
                lastGenerator = nextGenerator;
            }
        }
        self.cachedGenerators.get(degree).ok_or_else(|| {
            Exceptions::illegal_state_with(format!(
                "buildGenerator: missing cached generator for degree {degree}"
            ))
        })
    }

    pub fn encode(&mut self, to_encode: &mut [i32], ec_bytes: usize) -> Result<()> {
        if ec_bytes == 0 {
            return Err(Exceptions::illegal_argument_with(
                "No error correction bytes",
            ));
        }
        if ec_bytes > to_encode.len() {
            return Err(Exceptions::illegal_argument_with(
                "ec_bytes exceeds to_encode length",
            ));
        }
        let data_bytes = to_encode.len() - ec_bytes;
        if data_bytes == 0 {
            return Err(Exceptions::illegal_argument_with("No data bytes provided"));
        }
        let fld = self.field;
        let generator = self.buildGenerator(ec_bytes)?;
        let mut info_coefficients: Vec<i32> = vec![0; data_bytes];
        info_coefficients[0..data_bytes].clone_from_slice(&to_encode[0..data_bytes]);
        let mut info = GenericGFPoly::new(fld, &info_coefficients)?;
        info = info.multiply_by_monomial(ec_bytes, 1)?;
        let remainder = &info.divide(generator)?.1;
        let coefficients = remainder.getCoefficients();
        let num_zero_coefficients = ec_bytes - coefficients.len();
        for i in 0..num_zero_coefficients {
            to_encode[data_bytes + i] = 0;
        }
        to_encode[data_bytes + num_zero_coefficients
            ..(coefficients.len() + data_bytes + num_zero_coefficients)]
            .clone_from_slice(&coefficients[0..coefficients.len()]);
        Ok(())
    }
}
