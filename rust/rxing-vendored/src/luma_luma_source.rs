use std::borrow::Cow;

use crate::LuminanceSource;
use crate::common::Result;

/// A simple luma8 source for bytes. Supports cropping and 90° counter-clockwise
/// rotation; 45° rotation is not supported.
#[derive(Debug, Clone)]
pub struct Luma8LuminanceSource {
    /// image dimension in form (x,y)
    dimensions: (u32, u32),
    /// raw data for luma 8
    data: Box<[u8]>,
    /// flag indicating if the underlying data needs to be inverted for use
    inverted: bool,
}
impl LuminanceSource for Luma8LuminanceSource {
    const SUPPORTS_CROP: bool = true;
    const SUPPORTS_ROTATION: bool = true;

    fn get_row(&'_ self, y: usize) -> Option<Cow<'_, [u8]>> {
        let chunk_size = self.dimensions.0 as usize;
        let row_skip = y;
        let column_skip = 0;
        let column_take = self.dimensions.0 as usize;

        let data_start = (chunk_size * row_skip) + column_skip;
        let data_end = (chunk_size * row_skip) + column_skip + column_take;

        if self.inverted {
            Some(Cow::Owned(self.invert_block_of_bytes(Vec::from(
                &self.data[data_start..data_end],
            ))))
        } else {
            Some(Cow::Borrowed(&self.data[data_start..data_end]))
        }
    }

    fn get_column(&self, x: usize) -> Vec<u8> {
        self.data
            .chunks_exact(self.dimensions.0 as usize)
            .fold(Vec::with_capacity(self.get_height()), |mut acc, e| {
                let byte = e[x];
                acc.push(Self::invert_if_should(byte, self.inverted));
                acc
            })
    }

    fn get_matrix(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.data)
    }

    fn get_width(&self) -> usize {
        self.dimensions.0 as usize
    }

    fn get_height(&self) -> usize {
        self.dimensions.1 as usize
    }

    fn invert(&mut self) {
        self.inverted = !self.inverted;
    }

    fn crop(&self, left: usize, top: usize, width: usize, height: usize) -> Result<Self> {
        Ok(Self {
            dimensions: (width as u32, height as u32),
            data: self
                .data
                .chunks_exact(self.dimensions.0 as usize)
                .skip(top)
                .flat_map(|f| f.iter().skip(left).take(width))
                .map(|byte| Self::invert_if_should(*byte, self.inverted))
                .collect(),
            inverted: self.inverted,
        })
    }

    fn rotate_counter_clockwise(&self) -> Result<Self> {
        let mut new_matrix = Self {
            dimensions: self.dimensions,
            data: self.data.clone(),
            inverted: self.inverted,
        };
        new_matrix.transpose();
        new_matrix.reverseColumns();
        Ok(new_matrix)
    }

    fn rotate_counter_clockwise_45(&self) -> Result<Self> {
        Err(crate::Exceptions::unsupported_operation_with(
            "This luminance source does not support rotation by 45 degrees.",
        ))
    }

    fn get_luma8_point(&self, column: usize, row: usize) -> u8 {
        let chunk_size = self.dimensions.0 as usize;
        let row_skip = row;
        let column_skip = 0;

        let data_start = (chunk_size * row_skip) + column_skip;
        let data_point = data_start + column;

        Self::invert_if_should(self.data[data_point], self.inverted)
    }
}

impl Luma8LuminanceSource {
    fn reverseColumns(&mut self) {
        for col in 0..(self.get_width()) {
            let mut a = 0;
            let mut b = self.get_height() - 1;
            while a < b {
                let offset_a = a * self.get_width() + col;
                let offset_b = b * self.get_width() + col;
                self.data.swap(offset_a, offset_b);

                a += 1;
                b -= 1;
            }
        }
    }

    fn transpose_square(&mut self) {
        for i in 0..self.get_height() {
            for j in i..self.get_width() {
                let offset_a = (self.get_width() * i) + j;
                let offset_b = (self.get_width() * j) + i;
                self.data.swap(offset_a, offset_b);
            }
        }
    }

    fn transpose_rect(&mut self) {
        let mut new_data = vec![0; self.data.len()];
        let new_dim = (self.dimensions.1, self.dimensions.0);
        for i in 0..self.get_height() {
            for j in 0..self.get_width() {
                let offset_a = (self.get_width() * i) + j;
                let offset_b = (self.get_height() * j) + i;
                new_data[offset_b] = self.data[offset_a];
            }
        }
        self.data = new_data.into_boxed_slice();
        self.dimensions = new_dim;
    }

    fn transpose(&mut self) {
        if self.get_width() == self.get_height() {
            self.transpose_square()
        } else {
            self.transpose_rect()
        }
    }
}

impl Luma8LuminanceSource {
    pub fn new(source: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            dimensions: (width, height),
            data: source.into_boxed_slice(),
            inverted: false,
        }
    }

    pub fn with_empty_image(width: usize, height: usize) -> Self {
        Self {
            dimensions: (width as u32, height as u32),
            data: vec![0u8; width * height].into_boxed_slice(),
            inverted: false,
        }
    }

    pub fn get_matrix_mut(&mut self) -> &mut Box<[u8]> {
        &mut self.data
    }

    #[inline(always)]
    fn invert_if_should(byte: u8, invert: bool) -> u8 {
        if invert { 255 - byte } else { byte }
    }
}

/// Box-average downscale a row-major luma buffer by an integer `factor`.
/// New dimensions are `(width / factor, height / factor)`. Trailing edge
/// pixels that don't fit a full `factor × factor` block are dropped (truncating
/// division). `factor` must be ≥ 1; `factor == 1` returns a copy. Useful as a
/// pyramid-layer step for `try_harder`-style multi-resolution decoding
/// (mirrors zxing-cpp's `tryDownscale`).
pub fn downscale_luma_buffer(
    src: &[u8],
    width: u32,
    height: u32,
    factor: u32,
) -> (Vec<u8>, u32, u32) {
    assert!(factor >= 1, "downscale factor must be at least 1");
    assert_eq!(
        src.len(),
        (width as usize) * (height as usize),
        "downscale_luma_buffer: src.len() must equal width * height",
    );
    let new_w = width / factor;
    let new_h = height / factor;
    if factor == 1 {
        return (src.to_vec(), new_w, new_h);
    }
    let factor_us = factor as usize;
    let w_us = width as usize;
    let new_w_us = new_w as usize;
    let mut out = vec![0u8; new_w_us * new_h as usize];
    let half_area = (factor_us * factor_us) / 2;
    for dy in 0..new_h as usize {
        for dx in 0..new_w_us {
            let mut sum = half_area;
            for ty in 0..factor_us {
                for tx in 0..factor_us {
                    sum += src[(dy * factor_us + ty) * w_us + (dx * factor_us + tx)] as usize;
                }
            }
            out[dy * new_w_us + dx] = (sum / (factor_us * factor_us)) as u8;
        }
    }
    (out, new_w, new_h)
}

#[cfg(test)]
mod tests {
    use crate::{Luma8LuminanceSource, LuminanceSource};

    #[test]
    fn test_rotate() {
        let src_square = vec![1, 2, 3, 4, 5, 6, 7, 8, 9];

        let src_rect = vec![0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0];

        let square = Luma8LuminanceSource::new(src_square, 3, 3);
        let rect_tall = Luma8LuminanceSource::new(src_rect.clone(), 3, 4);
        let rect_wide = Luma8LuminanceSource::new(src_rect, 4, 3);

        let rotated_square = square.rotate_counter_clockwise().expect("rotate");
        let rotated_wide_rect = rect_wide.rotate_counter_clockwise().expect("rotate");
        let rotated_tall_rect = rect_tall.rotate_counter_clockwise().expect("rotate");

        assert_eq!(rotated_square.dimensions, square.dimensions);
        assert_eq!(
            rotated_tall_rect.dimensions,
            (rect_tall.dimensions.1, rect_tall.dimensions.0)
        );
        assert_eq!(
            rotated_wide_rect.dimensions,
            (rect_wide.dimensions.1, rect_wide.dimensions.0)
        );

        assert_eq!(
            rotated_square.data,
            vec![3, 6, 9, 2, 5, 8, 1, 4, 7].into_boxed_slice()
        );

        assert_eq!(
            rotated_wide_rect.data,
            vec![1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1].into_boxed_slice()
        );

        assert_eq!(
            rotated_tall_rect.data,
            vec![0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0].into_boxed_slice()
        );
    }
}
