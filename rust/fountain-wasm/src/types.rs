use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Represents a fountain-encoded chunk
#[wasm_bindgen]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FountainChunk {
    /// RNG seed for deterministic block selection
    pub seed: u32,
    /// Number of source blocks XORed together
    pub degree: usize,
    /// Indices of source blocks used in this chunk
    #[wasm_bindgen(skip)]
    pub indices: Vec<usize>,
    /// Encoded data (XOR of selected blocks)
    #[wasm_bindgen(skip)]
    pub data: Vec<u8>,
}

#[wasm_bindgen]
impl FountainChunk {
    /// Create a new FountainChunk with validation (WASM-exposed constructor)
    ///
    /// # Arguments
    /// * `seed` - RNG seed for deterministic block selection
    /// * `degree` - Number of source blocks XORed together
    /// * `indices` - Indices of source blocks used in this chunk
    /// * `data` - Encoded data (XOR of selected blocks)
    ///
    /// # Errors
    /// Returns a JS error if:
    /// - `indices` is empty
    /// - `data` is empty
    /// - `degree` does not equal `indices.len()` (inconsistent chunk specification)
    ///
    /// # Example
    /// ```javascript
    /// // Valid chunk
    /// const chunk = new FountainChunk(42, 2, [0, 1], new Uint8Array([0xAA, 0xBB]));
    ///
    /// // Errors:
    /// // new FountainChunk(42, 0, [], new Uint8Array([0xAA])); // "indices must be non-empty"
    /// // new FountainChunk(42, 2, [0, 1], new Uint8Array([])); // "data must be non-empty"
    /// // new FountainChunk(42, 3, [0, 1], new Uint8Array([0xAA])); // "degree must equal indices.len()"
    /// ```
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, degree: usize, indices: Vec<usize>, data: Vec<u8>) -> Result<FountainChunk, wasm_bindgen::JsValue> {
        // Validate indices is non-empty
        if indices.is_empty() {
            return Err(wasm_bindgen::JsValue::from_str("indices must be non-empty"));
        }

        // Validate data is non-empty
        if data.is_empty() {
            return Err(wasm_bindgen::JsValue::from_str("data must be non-empty"));
        }

        // Validate degree matches indices length
        if degree != indices.len() {
            return Err(wasm_bindgen::JsValue::from_str(
                &format!("degree must equal indices.len(): degree={}, indices.len()={}", degree, indices.len())
            ));
        }

        Ok(FountainChunk {
            seed,
            degree,
            indices,
            data,
        })
    }

    /// Internal constructor for Rust code (skips validation for performance)
    ///
    /// This is used internally by the encoder where we know the inputs are valid.
    /// Callers must ensure that:
    /// - indices is non-empty
    /// - data is non-empty
    /// - degree equals indices.len()
    pub(crate) fn new_unchecked(seed: u32, degree: usize, indices: Vec<usize>, data: Vec<u8>) -> Self {
        Self {
            seed,
            degree,
            indices,
            data,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<usize> {
        self.indices.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }
}

/// Metadata about the original file and fountain encoding parameters
#[wasm_bindgen]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FountainMetadata {
    /// Original filename
    #[wasm_bindgen(skip)]
    pub name: String,
    /// Original file size in bytes
    pub size: usize,
    /// MIME type
    #[wasm_bindgen(skip)]
    pub file_type: String,
    /// Unix timestamp
    pub timestamp: f64,
    /// Number of source blocks
    pub total_source_blocks: usize,
    /// Size of each block in bytes
    pub block_size: usize,
}

#[wasm_bindgen]
impl FountainMetadata {
    #[wasm_bindgen(constructor)]
    pub fn new(
        name: String,
        size: usize,
        file_type: String,
        timestamp: f64,
        total_source_blocks: usize,
        block_size: usize,
    ) -> Self {
        Self {
            name,
            size,
            file_type,
            timestamp,
            total_source_blocks,
            block_size,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    #[wasm_bindgen(getter, js_name = fileType)]
    pub fn file_type(&self) -> String {
        self.file_type.clone()
    }
}

/// Configuration options for the fountain encoder
/// All fields are required - defaults should be provided by TypeScript layer
/// These are algorithm parameters, not session settings
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FountainEncoderOptions {
    /// Size of each source block (default: 400 bytes)
    pub block_size: usize,
    /// Robust soliton distribution parameter (default: 0.2)
    pub c: f64,
    /// Failure probability (default: 0.01)
    pub delta: f64,
    /// Maximum degree (auto-calculated if None)
    pub max_degree: Option<usize>,
    /// Forced degree-1 probability (default: 0.08)
    pub degree1_rate: f64,
    /// Low degree (2-3) probability (default: 0.18)
    pub low_degree_rate: f64,
    /// Maximum QR data size constraint (default: 1000 bytes)
    pub max_qr_data_size: usize,
    /// Fixed overhead in bytes: magic(2) + seed(2) + degree(1) + numIndices(1) + checksum(4) = 10
    pub fixed_overhead: usize,
    /// Part-based mode overhead in bytes: currentPart(2) + totalParts(2) + partChecksum(4) = 8
    pub part_overhead: usize,
}

impl Default for FountainEncoderOptions {
    fn default() -> Self {
        Self {
            block_size: 400,
            c: 0.2,
            delta: 0.01,
            max_degree: None,
            degree1_rate: 0.08,
            low_degree_rate: 0.18,
            max_qr_data_size: 1000,
            fixed_overhead: 10, // magic(2) + seed(2) + degree(1) + numIndices(1) + checksum(4)
            part_overhead: 0,   // 0 for non-part mode, 8 for part-based mode
        }
    }
}

impl FountainEncoderOptions {
    pub fn with_block_size(mut self, block_size: usize) -> Self {
        self.block_size = block_size;
        self
    }

    pub fn with_c(mut self, c: f64) -> Self {
        self.c = c;
        self
    }

    pub fn with_delta(mut self, delta: f64) -> Self {
        self.delta = delta;
        self
    }

    pub fn with_max_degree(mut self, max_degree: usize) -> Self {
        self.max_degree = Some(max_degree);
        self
    }

    pub fn with_degree1_rate(mut self, degree1_rate: f64) -> Self {
        self.degree1_rate = degree1_rate;
        self
    }

    pub fn with_low_degree_rate(mut self, low_degree_rate: f64) -> Self {
        self.low_degree_rate = low_degree_rate;
        self
    }

    pub fn with_max_qr_data_size(mut self, max_qr_data_size: usize) -> Self {
        self.max_qr_data_size = max_qr_data_size;
        self
    }

    pub fn with_fixed_overhead(mut self, fixed_overhead: usize) -> Self {
        self.fixed_overhead = fixed_overhead;
        self
    }

    pub fn with_part_overhead(mut self, part_overhead: usize) -> Self {
        self.part_overhead = part_overhead;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_valid_construction() {
        // Valid chunk should be constructible
        let result = FountainChunk::new(42, 2, vec![0, 1], vec![0xAA, 0xBB]);
        assert!(result.is_ok(), "Valid chunk should construct successfully");

        let chunk = result.unwrap();
        assert_eq!(chunk.seed, 42);
        assert_eq!(chunk.degree, 2);
        assert_eq!(chunk.indices, vec![0, 1]);
        assert_eq!(chunk.data, vec![0xAA, 0xBB]);
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_empty_indices_error() {
        // Empty indices should produce error
        let result = FountainChunk::new(42, 0, vec![], vec![0xAA]);
        assert!(result.is_err(), "Empty indices should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("indices must be non-empty"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_empty_data_error() {
        // Empty data should produce error
        let result = FountainChunk::new(42, 1, vec![0], vec![]);
        assert!(result.is_err(), "Empty data should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("data must be non-empty"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_degree_mismatch_error() {
        // Degree != indices.len() should produce error
        let result = FountainChunk::new(42, 3, vec![0, 1], vec![0xAA, 0xBB]);
        assert!(result.is_err(), "Degree mismatch should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("degree must equal indices.len()"));
        assert!(err_msg.contains("degree=3"));
        assert!(err_msg.contains("indices.len()=2"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_degree_zero_error() {
        // Degree 0 with empty indices should error on empty indices first
        let result = FountainChunk::new(42, 0, vec![], vec![0xFF]);
        assert!(result.is_err());

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("indices must be non-empty"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_single_byte_valid() {
        // Single byte data with single index should work
        let result = FountainChunk::new(100, 1, vec![5], vec![0x42]);
        assert!(result.is_ok());

        let chunk = result.unwrap();
        assert_eq!(chunk.seed, 100);
        assert_eq!(chunk.degree, 1);
        assert_eq!(chunk.indices, vec![5]);
        assert_eq!(chunk.data, vec![0x42]);
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_chunk_large_indices_valid() {
        // Multiple indices should work
        let indices = vec![0, 1, 2, 3, 4];
        let data = vec![0x00, 0x11, 0x22, 0x33, 0x44];
        let result = FountainChunk::new(999, 5, indices.clone(), data.clone());
        assert!(result.is_ok());

        let chunk = result.unwrap();
        assert_eq!(chunk.degree, 5);
        assert_eq!(chunk.indices, indices);
        assert_eq!(chunk.data, data);
    }

    #[test]
    fn test_fountain_chunk_unchecked_constructor() {
        // Unchecked constructor should always succeed
        let chunk = FountainChunk::new_unchecked(42, 2, vec![0, 1], vec![0xAA, 0xBB]);
        assert_eq!(chunk.seed, 42);
        assert_eq!(chunk.degree, 2);
        assert_eq!(chunk.indices, vec![0, 1]);
        assert_eq!(chunk.data, vec![0xAA, 0xBB]);
    }

    #[test]
    fn test_fountain_encoder_options_default() {
        let options = FountainEncoderOptions::default();
        assert_eq!(options.block_size, 400);
        assert_eq!(options.c, 0.2);
        assert_eq!(options.delta, 0.01);
        assert_eq!(options.degree1_rate, 0.08);
        assert_eq!(options.low_degree_rate, 0.18);
        assert_eq!(options.max_qr_data_size, 1000);
    }

    #[test]
    fn test_fountain_encoder_options_builder() {
        let options = FountainEncoderOptions::default()
            .with_block_size(512)
            .with_c(0.3)
            .with_delta(0.02)
            .with_max_degree(10)
            .with_degree1_rate(0.1);

        assert_eq!(options.block_size, 512);
        assert_eq!(options.c, 0.3);
        assert_eq!(options.delta, 0.02);
        assert_eq!(options.max_degree, Some(10));
        assert_eq!(options.degree1_rate, 0.1);
    }
}
