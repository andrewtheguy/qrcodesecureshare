/*
 * Copyright 2009 ZXing authors
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

use std::{borrow::Cow, fmt};

use once_cell::sync::OnceCell;

use crate::{
    Binarizer, LuminanceSource,
    common::{BitArray, BitMatrix, LineOrientation, Result},
};

/**
 * This class is the core bitmap class used by ZXing to represent 1 bit data. Reader objects
 * accept a BinaryBitmap and attempt to decode it.
 *
 * @author dswitkin@google.com (Daniel Switkin)
 */
pub struct BinaryBitmap<B: Binarizer> {
    binarizer: B,
    pub(crate) matrix: OnceCell<BitMatrix>,
}

impl<B: Binarizer> BinaryBitmap<B> {
    pub fn new(binarizer: B) -> Self {
        Self {
            matrix: OnceCell::new(),
            binarizer,
        }
    }

    /**
     * @return The width of the bitmap.
     */
    pub fn get_width(&self) -> usize {
        self.binarizer.get_width()
    }

    /**
     * @return The height of the bitmap.
     */
    pub fn get_height(&self) -> usize {
        self.binarizer.get_height()
    }

    /**
     * Converts one row of luminance data to 1 bit data. May actually do the conversion, or return
     * cached data. Callers should assume this method is expensive and call it as seldom as possible.
     * This method is intended for decoding 1D barcodes and may choose to apply sharpening.
     *
     * @param y The row to fetch, which must be in [0, bitmap height)
     * @param row An optional preallocated array. If null or too small, it will be ignored.
     *            If used, the Binarizer will call BitArray.clear(). Always use the returned object.
     * @return The array of bits for this row (true means black).
     * @throws NotFoundException if row can't be binarized
     */
    pub fn get_black_row(&self, y: usize) -> Result<Cow<'_, BitArray>> {
        self.binarizer.get_black_row(y)
    }

    /// Get a row or column of the image
    pub fn get_black_line(&self, l: usize, lt: LineOrientation) -> Result<Cow<'_, BitArray>> {
        self.binarizer.get_black_line(l, lt)
    }

    /**
     * Converts a 2D array of luminance data to 1 bit. As above, assume this method is expensive
     * and do not call it repeatedly. This method is intended for decoding 2D barcodes and may or
     * may not apply sharpening. Therefore, a row from this matrix may not be identical to one
     * fetched using getBlackRow(), so don't mix and match between them.
     *
     * @return The 2D array of bits for the image (true means black).
     * @throws NotFoundException if image can't be binarized to make a matrix
     */
    pub fn get_black_matrix_mut(&mut self) -> Result<&mut BitMatrix> {
        self.matrix
            .get_or_try_init(|| self.binarizer.get_black_matrix().cloned())?;
        Ok(self.matrix.get_mut().unwrap())
    }

    /**
     * Converts a 2D array of luminance data to 1 bit. As above, assume this method is expensive
     * and do not call it repeatedly. This method is intended for decoding 2D barcodes and may or
     * may not apply sharpening. Therefore, a row from this matrix may not be identical to one
     * fetched using getBlackRow(), so don't mix and match between them.
     *
     * @return The 2D array of bits for the image (true means black).
     * @throws NotFoundException if image can't be binarized to make a matrix
     */
    pub fn get_black_matrix(&self) -> Result<&BitMatrix> {
        self.matrix
            .get_or_try_init(|| self.binarizer.get_black_matrix().cloned())
    }

    /**
     * @return Whether this bitmap can be cropped.
     */
    pub fn is_crop_supported(&self) -> bool {
        self.binarizer.get_luminance_source().is_crop_supported()
    }

    /**
     * Returns a new object with cropped image data. Implementations may keep a reference to the
     * original data rather than a copy. Only callable if isCropSupported() is true.
     *
     * @param left The left coordinate, which must be in [0,getWidth())
     * @param top The top coordinate, which must be in [0,getHeight())
     * @param width The width of the rectangle to crop.
     * @param height The height of the rectangle to crop.
     * @return A cropped version of this object, or an error if the luminance source cannot be cropped.
     */
    pub fn crop(
        &mut self,
        left: usize,
        top: usize,
        width: usize,
        height: usize,
    ) -> Result<Self> {
        let newSource = self
            .binarizer
            .get_luminance_source()
            .crop(left, top, width, height)?;
        Ok(BinaryBitmap::new(self.binarizer.create_binarizer(newSource)))
    }

    /**
     * @return Whether this bitmap supports counter-clockwise rotation.
     */
    pub fn is_rotate_supported(&self) -> bool {
        self.binarizer.get_luminance_source().is_rotate_supported()
    }

    /**
     * Returns a new object with rotated image data by 90 degrees counterclockwise.
     * Only callable if {@link #isRotateSupported()} is true.
     *
     * @return A rotated version of this object, or an error if the luminance source cannot be rotated.
     */
    pub fn rotate_counter_clockwise(&mut self) -> Result<Self> {
        let newSource = self
            .binarizer
            .get_luminance_source()
            .rotate_counter_clockwise()?;
        Ok(BinaryBitmap::new(self.binarizer.create_binarizer(newSource)))
    }

    /**
     * Returns a new object with rotated image data by 45 degrees counterclockwise.
     * Only callable if {@link #isRotateSupported()} is true.
     *
     * @return A rotated version of this object, or an error if the luminance source cannot be rotated.
     */
    pub fn rotate_counter_clockwise_45(&self) -> Result<Self> {
        let newSource = self
            .binarizer
            .get_luminance_source()
            .rotate_counter_clockwise_45()?;
        Ok(BinaryBitmap::new(self.binarizer.create_binarizer(newSource)))
    }

    pub fn get_source(&self) -> &B::Source {
        self.binarizer.get_luminance_source()
    }

    pub fn get_binarizer(&self) -> &B {
        &self.binarizer
    }

    /// Apply a 3×3 morphological close to the cached BitMatrix: dilate (set
    /// any pixel whose 3×3 neighborhood contains at least one black pixel),
    /// then erode (keep only pixels whose 3×3 neighborhood is entirely
    /// black). Useful as a post-binarization denoise step for marginal
    /// photos (cf. zxing-cpp's `tryDenoise`). The 1-pixel border is left
    /// unchanged. No-op if the matrix is smaller than 3×3.
    pub fn close(&mut self) -> Result<()> {
        let matrix = self.get_black_matrix_mut()?;
        let (w, h) = (matrix.width(), matrix.height());
        if w < 3 || h < 3 {
            return Ok(());
        }
        let mut tmp = BitMatrix::new(w, h)?;
        sum_filter_3x3(matrix, &mut tmp, |sum| sum > 0); // dilate
        sum_filter_3x3(&tmp, matrix, |sum| sum == 9); // erode
        Ok(())
    }
}

/// 3×3 neighborhood scan: for each interior pixel of `output`, sum the 9
/// `input` pixels in its 3×3 neighborhood and run `predicate` on the count.
/// Out-of-bounds reads default to false (only touches the 1-pixel border).
fn sum_filter_3x3<F: Fn(u8) -> bool>(input: &BitMatrix, output: &mut BitMatrix, predicate: F) {
    let (w, h) = (output.width(), output.height());
    for row in 1..h - 1 {
        for col in 1..w - 1 {
            let mut sum: u8 = 0;
            for dx in 0..3u32 {
                sum += input.try_get(col + dx - 1, row - 1).unwrap_or(false) as u8
                    + input.try_get(col + dx - 1, row).unwrap_or(false) as u8
                    + input.try_get(col + dx - 1, row + 1).unwrap_or(false) as u8;
            }
            output.set_bool(col, row, predicate(sum));
        }
    }
}

impl<B: Binarizer> fmt::Display for BinaryBitmap<B> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.matrix.get() {
            Some(m) => write!(f, "{m:?}"),
            None => write!(f, "<uninitialized>"),
        }
    }
}
