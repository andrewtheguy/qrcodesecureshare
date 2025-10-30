mod checksum;
mod decoder;
mod distribution;
mod encoder;
mod rng;
mod types;
mod xor;

#[cfg(test)]
mod tests;

use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

pub use types::{FountainChunk, FountainMetadata};

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
            if part_size > data_vec.len() {
                return Err(JsValue::from_str(&format!(
                    "part_size ({}) must not exceed data length ({})",
                    part_size,
                    data_vec.len()
                )));
            }
        }

        // Deserialize options from JS (all fields required, TypeScript must provide complete object)
        let options: types::FountainEncoderOptions = serde_wasm_bindgen::from_value(options_js)
            .map_err(|e| JsValue::from_str(&format!("Invalid options: {}", e)))?;

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

    /// Get part info as a JS object
    /// Returns { partBasedMode, currentPartIndex, totalParts, partSize, currentPartChecksum?, partChecksums? }
    #[wasm_bindgen(js_name = getPartInfo)]
    pub fn get_part_info(&self) -> JsValue {
        let (part_based_mode, current_part_index, total_parts, part_size) =
            self.encoder.get_part_info();

        // Validate that values fit in u32
        if current_part_index > u32::MAX as usize
            || total_parts > u32::MAX as usize
            || part_size > u32::MAX as usize
        {
            web_sys::console::error_1(&"Part info values exceed u32::MAX".into());
        }

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &"partBasedMode".into(),
            &JsValue::from(part_based_mode),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &"currentPartIndex".into(),
            &JsValue::from(current_part_index as u32),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &"totalParts".into(),
            &JsValue::from(total_parts as u32),
        )
        .ok();
        js_sys::Reflect::set(&obj, &"partSize".into(), &JsValue::from(part_size as u32)).ok();

        // Add current part checksum if available
        if let Some(checksum) = self.encoder.get_current_part_checksum() {
            js_sys::Reflect::set(
                &obj,
                &"currentPartChecksum".into(),
                &JsValue::from_str(checksum),
            )
            .ok();
        }

        // Add all part checksums if available
        let checksums = self.encoder.get_part_checksums();
        if !checksums.is_empty() {
            let checksums_array = Array::new();
            for checksum in checksums {
                checksums_array.push(&JsValue::from_str(checksum));
            }
            js_sys::Reflect::set(&obj, &"partChecksums".into(), &checksums_array).ok();
        }

        obj.into()
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

    /// Get part info as a JS object
    /// Returns { partBasedMode, currentPartIndex, totalParts, partSize }
    #[wasm_bindgen(js_name = getPartInfo)]
    pub fn get_part_info(&self) -> JsValue {
        let (part_based_mode, current_part_index, total_parts, part_size) =
            self.decoder.get_part_info();

        // Validate that values fit in u32
        if current_part_index > u32::MAX as usize
            || total_parts > u32::MAX as usize
            || part_size > u32::MAX as usize
        {
            web_sys::console::error_1(&"Part info values exceed u32::MAX".into());
        }

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &"partBasedMode".into(),
            &JsValue::from(part_based_mode),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &"currentPartIndex".into(),
            &JsValue::from(current_part_index as u32),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &"totalParts".into(),
            &JsValue::from(total_parts as u32),
        )
        .ok();
        js_sys::Reflect::set(&obj, &"partSize".into(), &JsValue::from(part_size as u32)).ok();

        obj.into()
    }
}

/// Compute CRC32 checksum of the given data
///
/// # Arguments
/// * `data` - The data to checksum as a Uint8Array
///
/// # Returns
/// Lowercase hexadecimal string representation of the CRC32 checksum (e.g., "0d4a1185")
#[wasm_bindgen]
pub fn crc32(data: Uint8Array) -> String {
    let data_vec = data.to_vec();
    checksum::crc32(&data_vec)
}
