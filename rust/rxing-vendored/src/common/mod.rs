pub mod detector;
pub mod reedsolomon;

use crate::Point;

pub mod string_utils;

mod bit_array;
pub use bit_array::*;

pub type Result<T, E = crate::Exceptions> = std::result::Result<T, E>;

/// Encapsulates the result of detecting a barcode in an image.
pub trait DetectorRXingResult {
    fn getBits(&self) -> &BitMatrix;
    fn getPoints(&self) -> &[Point];
}

mod bit_matrix;
pub use bit_matrix::*;

mod eci_input;
pub use eci_input::*;

mod bit_source;
pub use bit_source::*;

mod perspective_transform;
pub use perspective_transform::*;

mod decoder_rxing_result;
pub use decoder_rxing_result::*;

mod bit_source_builder;
pub use bit_source_builder::*;

mod grid_sampler;
pub use grid_sampler::*;

mod default_grid_sampler;
pub use default_grid_sampler::*;

mod character_set;
pub use character_set::*;

mod eci_string_builder;
pub use eci_string_builder::*;

mod eci_encoder_set;
pub use eci_encoder_set::*;

mod minimal_eci_input;
pub use minimal_eci_input::*;

mod global_histogram_binarizer;
pub use global_histogram_binarizer::*;

mod hybrid_binarizer;
pub use hybrid_binarizer::*;

mod eci;
pub use eci::*;

mod quad;
pub use quad::*;

pub mod cpp_essentials;

mod line_orientation;
pub use line_orientation::LineOrientation;

pub type BitFieldBaseType = usize;
pub const BIT_FIELD_BASE_BITS: usize = BitFieldBaseType::BITS as usize;
pub const BIT_FIELD_SHIFT_BITS: usize = BIT_FIELD_BASE_BITS - 1;

mod pattern_reader;
