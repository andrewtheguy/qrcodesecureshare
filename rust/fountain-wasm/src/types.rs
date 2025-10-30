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

    /// Get the indices of source blocks used in this chunk.
    ///
    /// ⚠️ **Performance Note:** This method clones the entire `indices` Vec on every call.
    /// This is required by wasm-bindgen for WASM interop (JavaScript cannot directly access
    /// Rust vectors). For large chunks with many indices, repeated calls can be expensive.
    ///
    /// **Alternatives to Consider:**
    /// - Cache the result on the JavaScript side: store the indices once and reuse them
    /// - Use `FountainChunk::new()` constructor validation instead of re-accessing indices
    /// - For bulk operations, collect multiple chunks before processing indices
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<usize> {
        self.indices.clone()
    }

    /// Get the encoded data (XOR of selected source blocks).
    ///
    /// ⚠️ **Performance Note:** This method clones the entire `data` Vec on every call.
    /// This is required by wasm-bindgen for WASM interop (JavaScript receives a copy, not
    /// a reference to internal Rust memory). For large payloads (typical chunks are 400+ bytes),
    /// repeated calls can be expensive and may trigger garbage collection pressure.
    ///
    /// **Alternatives to Consider:**
    /// - Cache the result on the JavaScript side after the first call
    /// - Use streaming/chunked processing to avoid keeping multiple data copies in memory
    /// - Consider processing chunks immediately after generation before accessing data multiple times
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
    /// Create a new FountainMetadata with validation (WASM-exposed constructor)
    ///
    /// # Arguments
    /// * `name` - Original filename
    /// * `size` - Original file size in bytes (must be > 0)
    /// * `file_type` - MIME type
    /// * `timestamp` - Unix timestamp (should be non-negative)
    /// * `total_source_blocks` - Number of source blocks (must be > 0)
    /// * `block_size` - Size of each block in bytes (must be > 0)
    ///
    /// # Errors
    /// Returns a JS error if:
    /// - `size` is 0 or exceeds usize::MAX
    /// - `total_source_blocks` is 0
    /// - `block_size` is 0
    /// - `timestamp` is negative (indicates invalid Unix timestamp)
    ///
    /// # Example
    /// ```javascript
    /// // Valid metadata
    /// const metadata = new FountainMetadata("file.bin", 1000, "application/octet-stream", 1699000000, 3, 400);
    ///
    /// // Errors:
    /// // new FountainMetadata("file.bin", 0, "application/octet-stream", 1699000000, 3, 400);
    /// // → "size must be > 0"
    /// // new FountainMetadata("file.bin", 1000, "application/octet-stream", 1699000000, 0, 400);
    /// // → "total_source_blocks must be > 0"
    /// // new FountainMetadata("file.bin", 1000, "application/octet-stream", -1, 3, 400);
    /// // → "timestamp must be non-negative (valid Unix timestamp)"
    /// ```
    #[wasm_bindgen(constructor)]
    pub fn new(
        name: String,
        size: usize,
        file_type: String,
        timestamp: f64,
        total_source_blocks: usize,
        block_size: usize,
    ) -> Result<FountainMetadata, wasm_bindgen::JsValue> {
        // Validate size is positive
        if size == 0 {
            return Err(wasm_bindgen::JsValue::from_str("size must be > 0"));
        }

        // Validate total_source_blocks is positive
        if total_source_blocks == 0 {
            return Err(wasm_bindgen::JsValue::from_str(
                "total_source_blocks must be > 0",
            ));
        }

        // Validate block_size is positive
        if block_size == 0 {
            return Err(wasm_bindgen::JsValue::from_str("block_size must be > 0"));
        }

        // Validate timestamp is non-negative (valid Unix timestamp)
        if timestamp < 0.0 {
            return Err(wasm_bindgen::JsValue::from_str(
                "timestamp must be non-negative (valid Unix timestamp)",
            ));
        }

        Ok(FountainMetadata {
            name,
            size,
            file_type,
            timestamp,
            total_source_blocks,
            block_size,
        })
    }

    /// Internal constructor for Rust code (skips validation for performance)
    ///
    /// This is used internally by the encoder where we know the inputs are valid.
    /// Callers must ensure that:
    /// - size is > 0
    /// - total_source_blocks is > 0
    /// - block_size is > 0
    /// - timestamp is non-negative
    pub(crate) fn new_unchecked(
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

    /// Clear the max_degree constraint, allowing it to be auto-calculated.
    ///
    /// When max_degree is None, the encoder will automatically calculate an appropriate
    /// maximum degree based on the robust soliton distribution parameters and the number
    /// of source blocks.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let options = FountainEncoderOptions::default()
    ///     .with_max_degree(10)
    ///     .without_max_degree();  // Reset to auto-calculation
    /// assert_eq!(options.max_degree, None);
    /// ```
    pub fn without_max_degree(mut self) -> Self {
        self.max_degree = None;
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

    /// Validate all algorithm parameters for correctness and consistency.
    ///
    /// # Validation Rules
    ///
    /// **Size Parameters (must be > 0):**
    /// - `block_size`: Must be positive (typical: 200-1000 bytes)
    /// - `max_qr_data_size`: Must be positive (typical: 500-2000 bytes)
    /// - `fixed_overhead`: Must be positive (typical: 8-20 bytes)
    /// - `part_overhead`: Not validated here (can be 0 for non-part mode, validated at encoder creation)
    ///
    /// **Probability Parameters (must be in 0.0..=1.0):**
    /// - `c`: Robust soliton distribution constant (typical: 0.1-0.5)
    /// - `delta`: Failure probability (typical: 0.001-0.1)
    /// - `degree1_rate`: Probability of degree-1 chunks (typical: 0.05-0.15)
    /// - `low_degree_rate`: Probability of low-degree chunks (typical: 0.1-0.3)
    ///
    /// **Degree Parameter (if specified, must be >= 1):**
    /// - `max_degree`: If `Some`, must be at least 1
    ///
    /// # Errors
    ///
    /// Returns a descriptive error message identifying all invalid parameters.
    /// Errors are collected and reported together to help users fix multiple issues at once.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let options = FountainEncoderOptions {
    ///     block_size: 0,  // Invalid!
    ///     c: 1.5,         // Invalid! (exceeds 1.0)
    ///     delta: 0.01,    // Valid
    ///     max_degree: Some(0),  // Invalid!
    ///     // ... other fields
    /// };
    ///
    /// if let Err(e) = options.validate() {
    ///     eprintln!("Configuration error: {}", e);
    ///     // Output: "Configuration error: block_size must be > 0, c must be in range 0.0..=1.0, max_degree must be >= 1"
    /// }
    /// ```
    pub fn validate(&self) -> Result<(), String> {
        let mut errors = Vec::new();

        // Validate size parameters (must be > 0)
        if self.block_size == 0 {
            errors.push("block_size must be > 0".to_string());
        }
        if self.max_qr_data_size == 0 {
            errors.push("max_qr_data_size must be > 0".to_string());
        }
        if self.fixed_overhead == 0 {
            errors.push("fixed_overhead must be > 0".to_string());
        }
        // Note: part_overhead can be 0 for non-part mode, so we don't validate it here
        // It will be validated at encoder construction time if part_based_mode is enabled

        // Validate probability parameters (must be in 0.0..=1.0)
        if !(0.0..=1.0).contains(&self.c) {
            errors.push(format!(
                "c must be in range 0.0..=1.0, got {}",
                self.c
            ));
        }
        if !(0.0..=1.0).contains(&self.delta) {
            errors.push(format!(
                "delta must be in range 0.0..=1.0, got {}",
                self.delta
            ));
        }
        if !(0.0..=1.0).contains(&self.degree1_rate) {
            errors.push(format!(
                "degree1_rate must be in range 0.0..=1.0, got {}",
                self.degree1_rate
            ));
        }
        if !(0.0..=1.0).contains(&self.low_degree_rate) {
            errors.push(format!(
                "low_degree_rate must be in range 0.0..=1.0, got {}",
                self.low_degree_rate
            ));
        }

        // Validate max_degree if specified (must be >= 1)
        if let Some(max_deg) = self.max_degree {
            if max_deg == 0 {
                errors.push("max_degree must be >= 1, got 0".to_string());
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(", "))
        }
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

    #[test]
    fn test_fountain_encoder_options_without_max_degree() {
        // Test setting and then clearing max_degree
        let options = FountainEncoderOptions::default()
            .with_max_degree(10)
            .without_max_degree();

        assert_eq!(
            options.max_degree, None,
            "without_max_degree() should clear max_degree"
        );
    }

    #[test]
    fn test_fountain_encoder_options_without_max_degree_fluent() {
        // Test fluent chaining with without_max_degree
        let options = FountainEncoderOptions::default()
            .with_block_size(400)
            .with_max_degree(20)
            .with_delta(0.01)
            .without_max_degree()
            .with_c(0.25);

        assert_eq!(options.block_size, 400);
        assert_eq!(options.max_degree, None);
        assert_eq!(options.delta, 0.01);
        assert_eq!(options.c, 0.25);
    }

    #[test]
    fn test_fountain_encoder_options_without_max_degree_when_none() {
        // Test calling without_max_degree when max_degree is already None
        let options = FountainEncoderOptions::default().without_max_degree();

        assert_eq!(
            options.max_degree, None,
            "without_max_degree() on default (already None) should stay None"
        );
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_valid_construction() {
        // Valid metadata should construct successfully
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            1699000000.0,
            3,
            400,
        );
        assert!(result.is_ok(), "Valid metadata should construct successfully");

        let metadata = result.unwrap();
        assert_eq!(metadata.name, "test.dat");
        assert_eq!(metadata.size, 1000);
        assert_eq!(metadata.file_type, "application/octet-stream");
        assert_eq!(metadata.timestamp, 1699000000.0);
        assert_eq!(metadata.total_source_blocks, 3);
        assert_eq!(metadata.block_size, 400);
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_zero_size_error() {
        // Size of 0 should produce error
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            0,
            "application/octet-stream".to_string(),
            1699000000.0,
            3,
            400,
        );
        assert!(result.is_err(), "Zero size should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("size must be > 0"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_zero_total_source_blocks_error() {
        // Zero total_source_blocks should produce error
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            1699000000.0,
            0,
            400,
        );
        assert!(result.is_err(), "Zero total_source_blocks should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("total_source_blocks must be > 0"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_zero_block_size_error() {
        // Block size of 0 should produce error
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            1699000000.0,
            3,
            0,
        );
        assert!(result.is_err(), "Zero block_size should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("block_size must be > 0"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_negative_timestamp_error() {
        // Negative timestamp should produce error
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            -1.0,
            3,
            400,
        );
        assert!(result.is_err(), "Negative timestamp should produce error");

        let err = result.unwrap_err();
        let err_msg = err.as_string().unwrap_or_default();
        assert!(err_msg.contains("timestamp must be non-negative"));
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_fountain_metadata_zero_timestamp_valid() {
        // Zero timestamp (epoch) should be valid
        let result = FountainMetadata::new(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            0.0,
            3,
            400,
        );
        assert!(result.is_ok(), "Zero timestamp (epoch) should be valid");

        let metadata = result.unwrap();
        assert_eq!(metadata.timestamp, 0.0);
    }

    #[test]
    fn test_fountain_metadata_unchecked_constructor() {
        // Unchecked constructor should always succeed
        let metadata = FountainMetadata::new_unchecked(
            "test.dat".to_string(),
            1000,
            "application/octet-stream".to_string(),
            1699000000.0,
            3,
            400,
        );
        assert_eq!(metadata.name, "test.dat");
        assert_eq!(metadata.size, 1000);
        assert_eq!(metadata.file_type, "application/octet-stream");
        assert_eq!(metadata.timestamp, 1699000000.0);
        assert_eq!(metadata.total_source_blocks, 3);
        assert_eq!(metadata.block_size, 400);
    }

    #[test]
    fn test_fountain_encoder_options_validate_valid_defaults() {
        // Default options should always pass validation
        let options = FountainEncoderOptions::default();
        assert!(
            options.validate().is_ok(),
            "Default options should pass validation"
        );
    }

    #[test]
    fn test_fountain_encoder_options_validate_zero_block_size() {
        // Zero block_size should fail
        let options = FountainEncoderOptions {
            block_size: 0,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("block_size must be > 0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_zero_max_qr_data_size() {
        // Zero max_qr_data_size should fail
        let options = FountainEncoderOptions {
            max_qr_data_size: 0,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("max_qr_data_size must be > 0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_zero_fixed_overhead() {
        // Zero fixed_overhead should fail
        let options = FountainEncoderOptions {
            fixed_overhead: 0,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("fixed_overhead must be > 0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_part_overhead_allowed_zero() {
        // part_overhead can be 0 for non-part mode, so validation should pass
        let options = FountainEncoderOptions {
            part_overhead: 0,
            ..Default::default()
        };
        assert!(
            options.validate().is_ok(),
            "part_overhead can be 0 for non-part-based mode"
        );

        // Non-zero part_overhead should also pass
        let options = FountainEncoderOptions {
            part_overhead: 8,
            ..Default::default()
        };
        assert!(options.validate().is_ok());
    }

    #[test]
    fn test_fountain_encoder_options_validate_c_below_range() {
        // c < 0.0 should fail
        let options = FountainEncoderOptions {
            c: -0.1,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("c must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_c_above_range() {
        // c > 1.0 should fail
        let options = FountainEncoderOptions {
            c: 1.5,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("c must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_delta_below_range() {
        // delta < 0.0 should fail
        let options = FountainEncoderOptions {
            delta: -0.1,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("delta must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_delta_above_range() {
        // delta > 1.0 should fail
        let options = FountainEncoderOptions {
            delta: 2.0,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("delta must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_degree1_rate_below_range() {
        // degree1_rate < 0.0 should fail
        let options = FountainEncoderOptions {
            degree1_rate: -0.05,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("degree1_rate must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_degree1_rate_above_range() {
        // degree1_rate > 1.0 should fail
        let options = FountainEncoderOptions {
            degree1_rate: 1.5,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("degree1_rate must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_low_degree_rate_below_range() {
        // low_degree_rate < 0.0 should fail
        let options = FountainEncoderOptions {
            low_degree_rate: -0.1,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("low_degree_rate must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_low_degree_rate_above_range() {
        // low_degree_rate > 1.0 should fail
        let options = FountainEncoderOptions {
            low_degree_rate: 1.2,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("low_degree_rate must be in range 0.0..=1.0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_max_degree_zero() {
        // max_degree = 0 should fail
        let options = FountainEncoderOptions {
            max_degree: Some(0),
            ..Default::default()
        };
        let err = options.validate().unwrap_err();
        assert!(err.contains("max_degree must be >= 1, got 0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_max_degree_valid() {
        // max_degree = 1 and higher should pass
        let options = FountainEncoderOptions {
            max_degree: Some(1),
            ..Default::default()
        };
        assert!(options.validate().is_ok());

        let options = FountainEncoderOptions {
            max_degree: Some(100),
            ..Default::default()
        };
        assert!(options.validate().is_ok());
    }

    #[test]
    fn test_fountain_encoder_options_validate_multiple_errors() {
        // Multiple errors should all be reported together
        let options = FountainEncoderOptions {
            block_size: 0,
            c: 1.5,
            delta: -0.1,
            max_degree: Some(0),
            degree1_rate: 2.0,
            ..Default::default()
        };
        let err = options.validate().unwrap_err();

        // All errors should be in the message
        assert!(err.contains("block_size must be > 0"));
        assert!(err.contains("c must be in range 0.0..=1.0"));
        assert!(err.contains("delta must be in range 0.0..=1.0"));
        assert!(err.contains("degree1_rate must be in range 0.0..=1.0"));
        assert!(err.contains("max_degree must be >= 1, got 0"));
    }

    #[test]
    fn test_fountain_encoder_options_validate_boundary_values() {
        // Test boundary values for probabilities (0.0 and 1.0 should be valid)
        let options = FountainEncoderOptions {
            c: 0.0,
            delta: 1.0,
            degree1_rate: 0.0,
            low_degree_rate: 1.0,
            ..Default::default()
        };
        assert!(options.validate().is_ok(), "Boundary values (0.0 and 1.0) should be valid");
    }

    #[test]
    fn test_fountain_encoder_options_validate_custom_sizes() {
        // Custom but valid sizes should pass
        let options = FountainEncoderOptions {
            block_size: 512,
            max_qr_data_size: 2000,
            fixed_overhead: 20,
            part_overhead: 8,
            ..Default::default()
        };
        assert!(options.validate().is_ok());
    }
}
