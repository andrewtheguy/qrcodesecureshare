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
    /// * `block_size` - Optional block size (default: 400)
    /// * `c` - Optional robustness parameter (default: 0.2)
    /// * `delta` - Optional failure probability (default: 0.01)
    /// * `seed_offset` - Optional seed offset for session-specific randomization
    /// * `fixed_overhead` - Optional fixed overhead in bytes (default: 10)
    /// * `part_overhead` - Optional part-based mode overhead in bytes (default: 0)
    /// * `part_based_mode` - Optional enable part-based mode (default: false)
    /// * `part_size` - Optional part size in bytes (default: 0)
    #[wasm_bindgen(constructor)]
    pub fn new(
        data: Uint8Array,
        name: String,
        file_type: String,
        timestamp: f64,
        block_size: Option<usize>,
        c: Option<f64>,
        delta: Option<f64>,
        seed_offset: Option<u32>,
        fixed_overhead: Option<usize>,
        part_overhead: Option<usize>,
        max_degree: Option<usize>,
        degree1_rate: Option<f64>,
        low_degree_rate: Option<f64>,
        max_qr_data_size: Option<usize>,
        part_based_mode: Option<bool>,
        part_size: Option<usize>,
    ) -> Result<WasmFountainEncoder, JsValue> {
        // Convert Uint8Array to Vec<u8>
        let data_vec = data.to_vec();

        // Build options
        let mut options = types::FountainEncoderOptions::default();
        if let Some(bs) = block_size {
            options = options.with_block_size(bs);
        }
        if let Some(c_val) = c {
            options = options.with_c(c_val);
        }
        if let Some(d_val) = delta {
            options = options.with_delta(d_val);
        }
        if let Some(fo) = fixed_overhead {
            options = options.with_fixed_overhead(fo);
        }
        if let Some(po) = part_overhead {
            options = options.with_part_overhead(po);
        }
        if let Some(md) = max_degree {
            options = options.with_max_degree(md);
        }
        if let Some(d1) = degree1_rate {
            options = options.with_degree1_rate(d1);
        }
        if let Some(lr) = low_degree_rate {
            options = options.with_low_degree_rate(lr);
        }
        if let Some(max_qr) = max_qr_data_size {
            options = options.with_max_qr_data_size(max_qr);
        }
        if let Some(pbm) = part_based_mode {
            options = options.with_part_based_mode(pbm);
        }
        if let Some(ps) = part_size {
            options = options.with_part_size(ps);
        }

        let encoder = encoder::FountainEncoder::new(
            data_vec,
            name,
            file_type,
            timestamp,
            options,
            seed_offset,
        );

        Ok(WasmFountainEncoder { encoder })
    }

    /// Generate a single fountain chunk
    /// Returns a JS object with { seed, degree, indices, data }
    #[wasm_bindgen(js_name = generateChunk)]
    pub fn generate_chunk(&mut self) -> Result<JsValue, JsValue> {
        let chunk = self.encoder.generate_chunk();

        // Convert to JS-friendly format using serde
        serde_wasm_bindgen::to_value(&chunk)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
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
    // Targeted Mode Methods
    // ========================================

    /// Set which blocks the receiver has already decoded
    #[wasm_bindgen(js_name = setReceivedBlocks)]
    pub fn set_received_blocks(&mut self, block_indices: Vec<usize>) {
        self.encoder.set_received_blocks(block_indices);
    }

    /// Set which blocks the receiver still needs (missing blocks)
    #[wasm_bindgen(js_name = setMissingBlocks)]
    pub fn set_missing_blocks(&mut self, missing_indices: Vec<usize>) {
        self.encoder.set_missing_blocks(missing_indices);
    }

    // ========================================
    // Part-Based Mode Methods
    // ========================================

    /// Get part info as a JS object
    /// Returns { partBasedMode, currentPartIndex, totalParts, partSize }
    #[wasm_bindgen(js_name = getPartInfo)]
    pub fn get_part_info(&self) -> JsValue {
        let (part_based_mode, current_part_index, total_parts, part_size) =
            self.encoder.get_part_info();

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
    pub fn get_decoded_block_indices(&self) -> Array {
        let indices = self.decoder.get_decoded_block_indices();
        let array = Array::new();
        for idx in indices {
            array.push(&JsValue::from(idx as u32));
        }
        array
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
