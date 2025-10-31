mod checksum;
mod decoder;
mod distribution;
mod encoder;
mod parser;
mod rng;
mod types;
mod xor;

#[cfg(test)]
mod tests;

use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

pub use types::{FountainChunk, FountainMetadata, PartInfo, ParsedChunkResult, ParsedPartMetadata, ChecksumValidationResult, FinalChecksumValidationResult, PartCompleteInfo, ChunkProcessResult};
pub use parser::PartMetadata;

/// WASM-exported Fountain Encoder
#[wasm_bindgen]
pub struct WasmFountainEncoder {
    encoder: encoder::FountainEncoder,
}

#[wasm_bindgen]
impl WasmFountainEncoder {
    /// Create a new fountain encoder
    ///
    /// # Arguments
    /// * `data` - The data to encode as a Uint8Array
    /// * `name` - Filename
    /// * `file_type` - MIME type
    /// * `timestamp` - Unix timestamp
    /// * `options_js` - Complete encoder options object (all fields required from TypeScript)
    /// * `part_based_mode` - Whether part-based mode is enabled (session setting)
    /// * `part_size` - Size of each part in bytes (session setting)
    /// * `seed_offset` - Optional seed offset for session-specific randomization
    #[wasm_bindgen(constructor)]
    pub fn new(
        data: Uint8Array,
        name: String,
        file_type: String,
        timestamp: f64,
        options_js: JsValue,
        part_based_mode: bool,
        part_size: usize,
        seed_offset: Option<u32>,
    ) -> Result<WasmFountainEncoder, JsValue> {
        // Convert Uint8Array to Vec<u8>
        let data_vec = data.to_vec();

        // Validate part_size when part_based_mode is enabled
        if part_based_mode {
            if part_size == 0 {
                return Err(JsValue::from_str("part_size must be > 0"));
            }
            // Note: part_size can be larger than data length - it will result in a single part
            // The encoder correctly handles this with ceiling division: total_parts = (total_size + part_size - 1) / part_size
        }

        // Deserialize options from JS (all fields required, TypeScript must provide complete object)
        let options: types::FountainEncoderOptions = serde_wasm_bindgen::from_value(options_js)
            .map_err(|e| JsValue::from_str(&format!("Invalid options: {}", e)))?;

        // Validate all algorithm parameters before proceeding
        options
            .validate()
            .map_err(|e| JsValue::from_str(&format!("Invalid encoder options: {}", e)))?;

        let encoder = encoder::FountainEncoder::new(
            data_vec,
            name,
            file_type,
            timestamp,
            options,
            part_based_mode,
            part_size,
            seed_offset,
        );

        Ok(WasmFountainEncoder { encoder })
    }

    /// Generate a single fountain chunk
    /// Returns a JS object with { seed, degree, indices, data }, or null if no chunks can be generated
    ///
    /// Returns null when:
    /// - In part-based mode, all blocks in the current part have been cleared via `markPartCompleted()`
    /// - No blocks are available for encoding in the current state
    #[wasm_bindgen(js_name = generateChunk)]
    pub fn generate_chunk(&mut self) -> Result<JsValue, JsValue> {
        match self.encoder.generate_chunk() {
            Some(chunk) => {
                // Convert to JS-friendly format using serde
                serde_wasm_bindgen::to_value(&chunk)
                    .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
            }
            None => Ok(JsValue::null()),
        }
    }

    /// Get the metadata as a JS object
    #[wasm_bindgen(js_name = getMetadata)]
    pub fn get_metadata(&self) -> Result<JsValue, JsValue> {
        let metadata = self.encoder.get_metadata();
        serde_wasm_bindgen::to_value(&metadata)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Get the number of source blocks
    #[wasm_bindgen(js_name = blockCount)]
    pub fn block_count(&self) -> usize {
        self.encoder.block_count()
    }

    /// Get the block size
    #[wasm_bindgen(js_name = blockSize)]
    pub fn block_size(&self) -> usize {
        self.encoder.block_size()
    }

    // ========================================
    // Part-Based Mode Methods
    // ========================================

    /// Get part info as a Rust struct (internal)
    fn get_part_info_internal(&self) -> PartInfo {
        let (part_based_mode, current_part_index, total_parts, part_size) =
            self.encoder.get_part_info();

        // Validate that values fit in u32
        if current_part_index > u32::MAX as usize
            || total_parts > u32::MAX as usize
            || part_size > u32::MAX as usize
        {
            web_sys::console::error_1(&"Part info values exceed u32::MAX".into());
        }

        let current_part_checksum = self.encoder.get_current_part_checksum().map(|s| s.to_string());
        let checksums = self.encoder.get_part_checksums();
        let part_checksums = if !checksums.is_empty() {
            Some(checksums.into_iter().map(|s| s.to_string()).collect())
        } else {
            None
        };

        PartInfo {
            part_based_mode,
            current_part_index: current_part_index as u32,
            total_parts: total_parts as u32,
            part_size: part_size as u32,
            current_part_checksum,
            part_checksums,
        }
    }

    /// Get part info as a JS object
    /// Returns { partBasedMode, currentPartIndex, totalParts, partSize, currentPartChecksum?, partChecksums? }
    #[wasm_bindgen(js_name = getPartInfo)]
    pub fn get_part_info(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.get_part_info_internal()).unwrap_or(JsValue::NULL)
    }

    /// Set part checksums
    #[wasm_bindgen(js_name = setPartChecksums)]
    pub fn set_part_checksums(&mut self, checksums: Vec<String>) {
        self.encoder.set_part_checksums(checksums);
    }

    /// Move to the next part
    /// Returns true if moved, false if already at last part
    #[wasm_bindgen(js_name = moveToNextPart)]
    pub fn move_to_next_part(&mut self) -> bool {
        self.encoder.move_to_next_part()
    }

    /// Mark a part as completed
    #[wasm_bindgen(js_name = markPartCompleted)]
    pub fn mark_part_completed(&mut self, part_index: usize) {
        self.encoder.mark_part_completed(part_index);
    }

    /// Get contiguous blocks data
    #[wasm_bindgen(js_name = getContiguousBlocksData)]
    pub fn get_contiguous_blocks_data(&self, start_idx: usize, end_idx: usize) -> Option<Uint8Array> {
        self.encoder
            .get_contiguous_blocks_data(start_idx, end_idx)
            .map(|data| {
                let array = Uint8Array::new_with_length(data.len() as u32);
                array.copy_from(&data);
                array
            })
    }
}

/// WASM-exported Fountain Decoder
#[wasm_bindgen]
pub struct WasmFountainDecoder {
    decoder: decoder::FountainDecoder,
}

#[wasm_bindgen]
impl WasmFountainDecoder {
    /// Create a new fountain decoder
    ///
    /// # Arguments
    /// * `metadata` - Metadata object from encoder (as JS object)
    /// * `part_based_mode` - Optional: enable part-based mode
    /// * `part_size` - Optional: size of each part in bytes (required if part_based_mode is true)
    #[wasm_bindgen(constructor)]
    pub fn new(
        metadata: JsValue,
        part_based_mode: Option<bool>,
        part_size: Option<usize>,
    ) -> Result<WasmFountainDecoder, JsValue> {
        // Deserialize metadata from JS
        let metadata: FountainMetadata = serde_wasm_bindgen::from_value(metadata)
            .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))?;

        let decoder = if part_based_mode == Some(true) {
            let size = part_size.ok_or_else(|| {
                JsValue::from_str("part_size is required when part_based_mode is true")
            })?;
            if size == 0 {
                return Err(JsValue::from_str("part_size must be > 0"));
            }
            decoder::FountainDecoder::with_part_mode(metadata, size)
        } else {
            decoder::FountainDecoder::new(metadata)
        };

        Ok(WasmFountainDecoder { decoder })
    }

    /// Add a chunk to the decoder
    ///
    /// # Arguments
    /// * `chunk` - Chunk object with { seed, degree, indices, data }
    ///
    /// # Returns
    /// True if any new blocks were decoded
    #[wasm_bindgen(js_name = addChunk)]
    pub fn add_chunk(&mut self, chunk: JsValue) -> Result<bool, JsValue> {
        // Deserialize chunk from JS
        let chunk: FountainChunk = serde_wasm_bindgen::from_value(chunk)
            .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))?;

        Ok(self.decoder.add_chunk(chunk))
    }

    /// Check if decoding is complete
    #[wasm_bindgen(js_name = isComplete)]
    pub fn is_complete(&self) -> bool {
        self.decoder.is_complete()
    }

    /// Get decode progress (0.0 to 1.0)
    #[wasm_bindgen(js_name = getProgress)]
    pub fn get_progress(&self) -> f64 {
        self.decoder.get_progress()
    }

    /// Get number of decoded blocks
    #[wasm_bindgen(js_name = getDecodedBlockCount)]
    pub fn get_decoded_block_count(&self) -> usize {
        self.decoder.get_decoded_block_count()
    }

    /// Get number of received chunks
    #[wasm_bindgen(js_name = getReceivedChunkCount)]
    pub fn get_received_chunk_count(&self) -> usize {
        self.decoder.get_received_chunk_count()
    }

    /// Get decoded block indices as an array
    #[wasm_bindgen(js_name = getDecodedBlockIndices)]
    pub fn get_decoded_block_indices(&self) -> Result<Array, JsValue> {
        let indices = self.decoder.get_decoded_block_indices();
        let array = Array::new();
        for idx in indices {
            let idx_u32: u32 = idx.try_into().map_err(|_| {
                JsValue::from_str(&format!(
                    "Block index {} exceeds u32 maximum (4,294,967,295)",
                    idx
                ))
            })?;
            array.push(&JsValue::from(idx_u32));
        }
        Ok(array)
    }

    /// Get the decoded data (returns null if not complete)
    #[wasm_bindgen(js_name = getDecodedData)]
    pub fn get_decoded_data(&self) -> Option<Uint8Array> {
        self.decoder.get_decoded_data().map(|data| {
            let array = Uint8Array::new_with_length(data.len() as u32);
            array.copy_from(&data);
            array
        })
    }

    /// Get metadata
    #[wasm_bindgen(js_name = getMetadata)]
    pub fn get_metadata(&self) -> Result<JsValue, JsValue> {
        let metadata = self.decoder.get_metadata();
        serde_wasm_bindgen::to_value(&metadata)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    // Part-based mode methods

    /// Check if the current part is complete
    #[wasm_bindgen(js_name = isCurrentPartComplete)]
    pub fn is_current_part_complete(&self) -> bool {
        self.decoder.is_current_part_complete()
    }

    /// Get the current part data (returns null if not complete)
    #[wasm_bindgen(js_name = getCurrentPartData)]
    pub fn get_current_part_data(&self) -> Option<Uint8Array> {
        self.decoder.get_current_part_data().map(|data| {
            let array = Uint8Array::new_with_length(data.len() as u32);
            array.copy_from(&data);
            array
        })
    }

    /// Move to the next part
    /// Returns true if moved, false if already at last part
    #[wasm_bindgen(js_name = moveToNextPart)]
    pub fn move_to_next_part(&mut self) -> bool {
        self.decoder.move_to_next_part()
    }

    /// Mark a part as completed
    #[wasm_bindgen(js_name = markPartCompleted)]
    pub fn mark_part_completed(&mut self, part_index: usize) {
        self.decoder.mark_part_completed(part_index);
    }

    /// Get the number of decoded blocks in the current part
    #[wasm_bindgen(js_name = getCurrentPartDecodedBlockCount)]
    pub fn get_current_part_decoded_block_count(&self) -> usize {
        self.decoder.get_current_part_decoded_block_count()
    }

    /// Get the total number of blocks in the current part
    #[wasm_bindgen(js_name = getCurrentPartTotalBlockCount)]
    pub fn get_current_part_total_block_count(&self) -> usize {
        self.decoder.get_current_part_total_block_count()
    }

    /// Get part info as a Rust struct (internal)
    fn get_part_info_internal(&self) -> PartInfo {
        let (part_based_mode, current_part_index, total_parts, part_size) =
            self.decoder.get_part_info();

        // Validate that values fit in u32
        if current_part_index > u32::MAX as usize
            || total_parts > u32::MAX as usize
            || part_size > u32::MAX as usize
        {
            web_sys::console::error_1(&"Part info values exceed u32::MAX".into());
        }

        PartInfo {
            part_based_mode,
            current_part_index: current_part_index as u32,
            total_parts: total_parts as u32,
            part_size: part_size as u32,
            current_part_checksum: None,
            part_checksums: None,
        }
    }

    /// Get part info as a JS object
    /// Returns { partBasedMode, currentPartIndex, totalParts, partSize }
    #[wasm_bindgen(js_name = getPartInfo)]
    pub fn get_part_info(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.get_part_info_internal()).unwrap_or(JsValue::NULL)
    }

    /// Validate the current part's checksum against the expected value
    ///
    /// # Arguments
    /// * `expected_checksum` - The expected checksum bytes as a Uint8Array (4 bytes, big-endian)
    ///
    /// # Returns
    /// A validation result object with:
    /// - `isValid`: boolean indicating if checksums match
    /// - `expectedChecksum`: hex string of the expected checksum
    /// - `actualChecksum`: hex string of the computed checksum
    /// - `partIndex`: the current part index
    ///
    /// Returns null if not in part-based mode or if part data is not yet complete
    #[wasm_bindgen(js_name = validateCurrentPartChecksum)]
    pub fn validate_current_part_checksum(&self, expected_checksum: Uint8Array) -> Option<JsValue> {
        // Convert Uint8Array to [u8; 4]
        if expected_checksum.length() != 4 {
            web_sys::console::error_1(&format!("Expected checksum must be 4 bytes, got {}", expected_checksum.length()).into());
            return None;
        }

        let mut checksum_bytes = [0u8; 4];
        expected_checksum.copy_to(&mut checksum_bytes);

        // Call the decoder's validation method
        self.decoder
            .validate_current_part_checksum(checksum_bytes)
            .and_then(|result| serde_wasm_bindgen::to_value(&result).ok())
    }

    /// Validate the final decoded file's checksum against the expected value
    ///
    /// # Arguments
    /// * `expected_checksum_hex` - The expected checksum as a hex string (e.g., "0d4a1185")
    ///
    /// # Returns
    /// A validation result object with:
    /// - `isValid`: boolean indicating if checksums match
    /// - `expectedChecksum`: hex string of the expected checksum (normalized to lowercase)
    /// - `actualChecksum`: hex string of the computed checksum
    ///
    /// Returns null if decoding is not yet complete
    ///
    /// This method performs the checksum validation entirely in Rust, avoiding
    /// expensive checksum computation in JavaScript
    #[wasm_bindgen(js_name = validateFinalChecksum)]
    pub fn validate_final_checksum(&self, expected_checksum_hex: String) -> Option<JsValue> {
        // Call the decoder's validation method
        self.decoder
            .validate_final_checksum(&expected_checksum_hex)
            .and_then(|result| serde_wasm_bindgen::to_value(&result).ok())
    }

    /// Set the current session ID and clear dedup cache if session changed
    ///
    /// # Arguments
    /// * `session_id` - Session ID to track
    #[wasm_bindgen(js_name = setSessionId)]
    pub fn set_session_id(&mut self, session_id: u32) {
        self.decoder.set_session_id(session_id);
    }

    /// Set the expected checksum for a specific part
    ///
    /// # Arguments
    /// * `part_index` - Part index (0-indexed)
    /// * `checksum_bytes` - Checksum as 4 bytes (big-endian CRC32)
    #[wasm_bindgen(js_name = setExpectedPartChecksum)]
    pub fn set_expected_part_checksum(&mut self, part_index: u32, checksum_bytes: Uint8Array) -> Result<(), JsValue> {
        if checksum_bytes.length() != 4 {
            return Err(JsValue::from_str("checksum_bytes must be exactly 4 bytes"));
        }

        let mut checksum = [0u8; 4];
        checksum_bytes.copy_to(&mut checksum);
        self.decoder.set_expected_part_checksum(part_index as usize, checksum);
        Ok(())
    }

    /// Process a chunk with deduplication and part validation
    /// High-level orchestration that handles all chunk processing logic
    ///
    /// # Arguments
    /// * `chunk` - Chunk object with { seed, degree, indices, data }
    /// * `chunk_key` - Composite key for deduplication ("seed:degree:firstIdx:lastIdx")
    ///
    /// # Returns
    /// Result object with { is_duplicate, blocks_decoded, part_complete_info? }
    #[wasm_bindgen(js_name = processChunkWithValidation)]
    pub fn process_chunk_with_validation(&mut self, chunk: JsValue, chunk_key: String) -> Result<JsValue, JsValue> {
        // Deserialize chunk from JS
        let chunk: FountainChunk = serde_wasm_bindgen::from_value(chunk)
            .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))?;

        // Process chunk with validation
        let result = self.decoder.process_chunk_with_validation(chunk, chunk_key);

        // Convert result to JS value
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Force processing of all pending chunks in the queue
    ///
    /// # Returns
    /// Number of new blocks decoded from processing the pending chunks
    ///
    /// This is useful when:
    /// - Transmission is complete and you want to process remaining queued chunks
    /// - You haven't hit the throttle threshold but want to check for completion
    /// - You need to ensure all chunks are processed before checking status
    #[wasm_bindgen(js_name = flushPendingChunks)]
    pub fn flush_pending_chunks(&mut self) -> usize {
        self.decoder.flush_pending_chunks()
    }

    /// Get the number of pending chunks waiting to be processed
    ///
    /// # Returns
    /// Number of chunks in the pending queue
    #[wasm_bindgen(js_name = getPendingChunkCount)]
    pub fn get_pending_chunk_count(&self) -> usize {
        self.decoder.get_pending_chunk_count()
    }

    /// Set the decode throttle threshold (number of chunks before triggering decode)
    ///
    /// # Arguments
    /// * `count` - Number of non-duplicate chunks to accumulate before processing
    ///
    /// Default is 10. Lower values = more frequent decode attempts (more CPU but faster progress updates).
    /// Higher values = fewer decode attempts (less CPU but slower progress updates).
    #[wasm_bindgen(js_name = setDecodeThrottleCount)]
    pub fn set_decode_throttle_count(&mut self, count: usize) {
        self.decoder.set_decode_throttle_count(count);
    }

    /// Get the current decode throttle threshold
    ///
    /// # Returns
    /// Number of chunks that trigger a decode attempt
    #[wasm_bindgen(js_name = getDecodeThrottleCount)]
    pub fn get_decode_throttle_count(&self) -> usize {
        self.decoder.get_decode_throttle_count()
    }
}

/// Compute CRC32 checksum of the given data
///
/// # Arguments
/// * `data` - The data to checksum as a Uint8Array
///
/// # Returns
/// Lowercase hexadecimal string representation of the CRC32 checksum (e.g., "0d4a1185")
///
/// Note: The internal crc32 function returns bytes. This wrapper converts to hex for JavaScript.
#[wasm_bindgen]
pub fn crc32(data: Uint8Array) -> String {
    let data_vec = data.to_vec();
    let checksum_bytes = checksum::crc32(&data_vec);
    checksum::crc32_to_hex(&checksum_bytes)
}

/// Compute CRC32 checksum and return as raw bytes (4 bytes, big-endian)
///
/// # Arguments
/// * `data` - The data to checksum as a Uint8Array
///
/// # Returns
/// A Uint8Array containing the 4 bytes of the CRC32 checksum in big-endian format
#[wasm_bindgen]
pub fn crc32_bytes(data: Uint8Array) -> Uint8Array {
    let data_vec = data.to_vec();
    let checksum_bytes = checksum::crc32(&data_vec);
    Uint8Array::from(&checksum_bytes[..])
}

// ========================================
// Binary Chunk Parsing Functions
// ========================================

/// Parse binary chunk data into a FountainChunk with metadata
///
/// # Arguments
/// * `bytes` - The binary chunk data as Uint8Array
/// * `part_based_mode` - Whether part-based mode is enabled
/// * `total_source_blocks` - Total number of source blocks (for validation)
///
/// # Returns
/// A JS object with structure:
/// ```javascript
/// {
///   seed: number,
///   degree: number,
///   indices: number[],
///   data: Uint8Array,
///   checksumStart: number,
///   partMetadata?: {
///     currentPart: number,
///     totalParts: number,
///     partChecksum: Uint8Array
///   }
/// }
/// ```
///
/// Parse binary chunk into structured result (internal)
fn parse_binary_chunk_internal(
    bytes: &[u8],
    part_based_mode: bool,
    total_source_blocks: usize,
) -> Result<ParsedChunkResult, String> {
    let parsed = parser::parse_binary_chunk(bytes, part_based_mode, total_source_blocks)?;

    let indices = parsed.chunk.indices.iter().map(|&idx| idx as u32).collect();

    let part_metadata = parsed.part_metadata.map(|meta| ParsedPartMetadata {
        current_part: meta.current_part,
        total_parts: meta.total_parts,
        part_checksum: meta.part_checksum,
    });

    Ok(ParsedChunkResult {
        seed: parsed.chunk.seed,
        degree: parsed.chunk.degree as u32,
        indices,
        data: parsed.chunk.data,
        checksum_start: parsed.checksum_start as u32,
        part_metadata,
    })
}

/// # Errors
/// Returns JS error if parsing fails
#[wasm_bindgen(js_name = parseBinaryChunk)]
pub fn parse_binary_chunk_wasm(
    bytes: Uint8Array,
    part_based_mode: bool,
    total_source_blocks: usize,
) -> Result<JsValue, JsValue> {
    let bytes_vec = bytes.to_vec();
    let parsed = parse_binary_chunk_internal(&bytes_vec, part_based_mode, total_source_blocks)
        .map_err(|e| JsValue::from_str(&e))?;

    // Convert data to Uint8Array before serialization
    let data_array = Uint8Array::new_with_length(parsed.data.len() as u32);
    data_array.copy_from(&parsed.data);

    // Serialize the result (without data) to JsValue
    let obj = serde_wasm_bindgen::to_value(&parsed).unwrap_or(JsValue::NULL);

    // Add data array to the object
    js_sys::Reflect::set(&obj, &"data".into(), &data_array).ok();

    Ok(obj)
}

/// Create a composite dedup key for chunk identification
///
/// # Arguments
/// * `seed` - Chunk seed
/// * `degree` - Chunk degree
/// * `indices` - Chunk indices as array
///
/// # Returns
/// A string key in format "seed:degree:firstIdx:lastIdx"
#[wasm_bindgen(js_name = createChunkKey)]
pub fn create_chunk_key_wasm(seed: u32, degree: u32, indices: Array) -> Result<String, JsValue> {
    let mut indices_vec = Vec::new();
    for i in 0..indices.length() {
        let val = indices.get(i);
        let num = val.as_f64().ok_or_else(|| JsValue::from_str("Invalid index value"))?;
        indices_vec.push(num as usize);
    }

    Ok(parser::create_chunk_key(seed, degree as usize, &indices_vec))
}

/// Validate a CRC32 checksum within binary chunk data
///
/// # Arguments
/// * `bytes` - The full binary chunk data as Uint8Array
/// * `checksum_start` - Byte offset where the checksum begins
/// * `computed_checksum` - The computed checksum as a hex string (8 characters, lowercase)
///
/// # Returns
/// `true` if checksums match, `false` if they don't
///
/// # Errors
/// Returns JS error if validation setup fails
#[wasm_bindgen(js_name = validateChunkChecksum)]
pub fn validate_chunk_checksum_wasm(
    bytes: Uint8Array,
    checksum_start: usize,
    computed_checksum: String,
) -> Result<bool, JsValue> {
    let bytes_vec = bytes.to_vec();
    parser::validate_chunk_checksum(&bytes_vec, checksum_start, &computed_checksum)
        .map_err(|e| JsValue::from_str(&e))
}
