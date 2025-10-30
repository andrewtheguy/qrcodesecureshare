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
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, degree: usize, indices: Vec<usize>, data: Vec<u8>) -> Self {
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
#[derive(Clone, Debug)]
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
    /// Whether part-based mode is enabled
    pub part_based_mode: bool,
    /// Size of each part in bytes (for part-based mode)
    pub part_size: usize,
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
            part_based_mode: false,
            part_size: 0,
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

    pub fn with_part_based_mode(mut self, part_based_mode: bool) -> Self {
        self.part_based_mode = part_based_mode;
        self
    }

    pub fn with_part_size(mut self, part_size: usize) -> Self {
        self.part_size = part_size;
        self
    }
}
