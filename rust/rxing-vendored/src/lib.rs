#![allow(non_snake_case)]
#![allow(non_camel_case_types)]

pub mod common;
mod exceptions;

use std::{collections::HashMap, sync::Arc};

pub use exceptions::Exceptions;

pub type MetadataDictionary = HashMap<RXingResultMetadataType, RXingResultMetadataValue>;

mod barcode_format;
pub use barcode_format::*;

/// Callback which is invoked when a possible result point (significant
/// point in the barcode image such as a corner) is found.
pub type PointCallback = Arc<dyn Fn(Point) + Send + Sync>;

/// Temporary type to ease refactoring and keep backwards-compatibility.
pub type RXingResultPointCallback = PointCallback;

mod dimension;
pub use dimension::*;

pub mod qrcode;

// Reading
mod decode_hints;
pub use decode_hints::*;

mod rxing_result_metadata;
pub use rxing_result_metadata::*;

mod rxing_result;
pub use rxing_result::*;

mod result_point;
pub use result_point::*;

pub mod result_point_utils;

mod rxing_result_point;
pub use rxing_result_point::*;

pub type DecodingHintDictionary = HashMap<DecodeHintType, DecodeHintValue>;

// Reading sources
mod binarizer;
pub use binarizer::*;

mod binary_bitmap;
pub use binary_bitmap::*;

mod luminance_source;
pub use luminance_source::*;

mod luma_luma_source;
pub use luma_luma_source::*;
