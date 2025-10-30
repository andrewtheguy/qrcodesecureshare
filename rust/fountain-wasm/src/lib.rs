mod decoder;
mod distribution;
mod encoder;
mod rng;
mod types;
mod xor;

use wasm_bindgen::prelude::*;
use js_sys::{Array, Uint8Array};

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
    #[wasm_bindgen(constructor)]
    pub fn new(
        data: Uint8Array,
        name: String,
        file_type: String,
        timestamp: f64,
        block_size: Option<usize>,
        c: Option<f64>,
        delta: Option<f64>,
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

        let encoder = encoder::FountainEncoder::new(data_vec, name, file_type, timestamp, options);

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
    #[wasm_bindgen(constructor)]
    pub fn new(metadata: JsValue) -> Result<WasmFountainDecoder, JsValue> {
        // Deserialize metadata from JS
        let metadata: FountainMetadata = serde_wasm_bindgen::from_value(metadata)
            .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))?;

        let decoder = decoder::FountainDecoder::new(metadata);

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
}
