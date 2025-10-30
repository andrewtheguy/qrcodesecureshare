use crate::types::{FountainChunk, FountainMetadata};
use crate::xor::xor_into;
use std::collections::{HashMap, HashSet};

/// Internal representation of a chunk with active indices
#[derive(Clone)]
struct DecodingChunk {
    indices: HashSet<usize>,
    data: Vec<u8>,
}

pub struct FountainDecoder {
    /// Metadata about the encoding
    metadata: FountainMetadata,
    /// Decoded blocks (block_index -> data)
    decoded_blocks: HashMap<usize, Vec<u8>>,
    /// Chunks being processed
    chunks: Vec<DecodingChunk>,
    /// Number of chunks received
    received_chunk_count: usize,

    // Part-based mode fields
    /// Whether part-based mode is enabled
    part_based_mode: bool,
    /// Size of each part in bytes
    part_size: usize,
    /// Total number of parts
    total_parts: usize,
    /// Current part index being decoded
    current_part_index: usize,
    /// Set of completed part indices
    completed_parts: HashSet<usize>,
    /// Stored reconstructed part data (part_index -> data)
    stored_part_data: HashMap<usize, Vec<u8>>,
}

impl FountainDecoder {
    pub fn new(metadata: FountainMetadata) -> Self {
        Self {
            metadata,
            decoded_blocks: HashMap::new(),
            chunks: Vec::new(),
            received_chunk_count: 0,
            part_based_mode: false,
            part_size: 0,
            total_parts: 0,
            current_part_index: 0,
            completed_parts: HashSet::new(),
            stored_part_data: HashMap::new(),
        }
    }

    /// Create a new decoder with part-based mode
    pub fn with_part_mode(metadata: FountainMetadata, part_size: usize) -> Self {
        let total_parts = (metadata.size + part_size - 1) / part_size; // ceil division
        Self {
            metadata,
            decoded_blocks: HashMap::new(),
            chunks: Vec::new(),
            received_chunk_count: 0,
            part_based_mode: true,
            part_size,
            total_parts,
            current_part_index: 0,
            completed_parts: HashSet::new(),
            stored_part_data: HashMap::new(),
        }
    }

    /// Add a chunk and attempt to decode
    /// Returns true if any new blocks were decoded
    pub fn add_chunk(&mut self, chunk: FountainChunk) -> bool {
        self.received_chunk_count += 1;

        // Convert to internal format
        let mut decoding_chunk = DecodingChunk {
            indices: chunk.indices.into_iter().collect(),
            data: chunk.data,
        };

        // Remove already-decoded blocks from this chunk
        for &decoded_idx in self.decoded_blocks.keys() {
            if decoding_chunk.indices.contains(&decoded_idx) {
                xor_into(&mut decoding_chunk.data, &self.decoded_blocks[&decoded_idx]);
                decoding_chunk.indices.remove(&decoded_idx);
            }
        }

        // If chunk is now empty, discard it
        if decoding_chunk.indices.is_empty() {
            return false;
        }

        self.chunks.push(decoding_chunk);

        // Run belief propagation
        self.belief_propagation()
    }

    /// Belief propagation (peeling) decoder
    /// Returns true if any new blocks were decoded in this iteration
    fn belief_propagation(&mut self) -> bool {
        let mut decoded_any = false;

        loop {
            let mut decoded_this_round = false;

            // Find chunks with exactly one undecoded block
            let mut to_decode = Vec::new();
            for (chunk_idx, chunk) in self.chunks.iter().enumerate() {
                if chunk.indices.len() == 1 {
                    let block_idx = *chunk.indices.iter().next().unwrap();
                    to_decode.push((chunk_idx, block_idx, chunk.data.clone()));
                }
            }

            // Decode discovered blocks
            for (_chunk_idx, block_idx, data) in to_decode {
                if !self.decoded_blocks.contains_key(&block_idx) {
                    self.decoded_blocks.insert(block_idx, data.clone());
                    decoded_this_round = true;
                    decoded_any = true;

                    // XOR this block out of all other chunks
                    for chunk in self.chunks.iter_mut() {
                        if chunk.indices.contains(&block_idx) {
                            xor_into(&mut chunk.data, &data);
                            chunk.indices.remove(&block_idx);
                        }
                    }
                }
            }

            // Remove empty chunks
            self.chunks.retain(|c| !c.indices.is_empty());

            // Stop if no progress this round
            if !decoded_this_round {
                break;
            }
        }

        decoded_any
    }

    /// Check if decoding is complete
    pub fn is_complete(&self) -> bool {
        if self.part_based_mode {
            // In part-based mode, complete when all parts are stored
            self.stored_part_data.len() == self.total_parts
        } else {
            // Regular mode: complete when all blocks are decoded
            self.decoded_blocks.len() == self.metadata.total_source_blocks
        }
    }

    /// Get decode progress as a fraction (0.0 to 1.0)
    pub fn get_progress(&self) -> f64 {
        self.decoded_blocks.len() as f64 / self.metadata.total_source_blocks as f64
    }

    /// Get the number of decoded blocks
    pub fn get_decoded_block_count(&self) -> usize {
        self.decoded_blocks.len()
    }

    /// Get the number of received chunks
    pub fn get_received_chunk_count(&self) -> usize {
        self.received_chunk_count
    }

    /// Get sorted list of decoded block indices
    pub fn get_decoded_block_indices(&self) -> Vec<usize> {
        let mut indices: Vec<usize> = self.decoded_blocks.keys().copied().collect();
        indices.sort_unstable();
        indices
    }

    /// Get the decoded data (returns None if not complete)
    pub fn get_decoded_data(&self) -> Option<Vec<u8>> {
        if self.part_based_mode {
            return self.get_decoded_data_from_parts();
        }

        if !self.is_complete() {
            return None;
        }

        // Reassemble blocks in order
        let mut result = Vec::new();
        for i in 0..self.metadata.total_source_blocks {
            if let Some(block) = self.decoded_blocks.get(&i) {
                result.extend_from_slice(block);
            } else {
                // Should never happen if is_complete() returned true
                return None;
            }
        }

        // Trim to original size
        result.truncate(self.metadata.size);
        Some(result)
    }

    /// Reconstruct the final file from stored part data
    fn get_decoded_data_from_parts(&self) -> Option<Vec<u8>> {
        if !self.part_based_mode || self.stored_part_data.len() != self.total_parts {
            return None;
        }

        // Check that all parts are present
        for i in 0..self.total_parts {
            if !self.stored_part_data.contains_key(&i) {
                return None;
            }
        }

        // Concatenate all parts in order
        let mut result = Vec::with_capacity(self.metadata.size);
        for i in 0..self.total_parts {
            if let Some(part_data) = self.stored_part_data.get(&i) {
                result.extend_from_slice(part_data);
            } else {
                return None;
            }
        }

        Some(result)
    }

    /// Get metadata
    pub fn get_metadata(&self) -> FountainMetadata {
        self.metadata.clone()
    }

    // Part-based mode methods

    /// Check if the current part is complete (all blocks in part decoded)
    pub fn is_current_part_complete(&self) -> bool {
        if !self.part_based_mode {
            return self.is_complete();
        }

        let (start_block, end_block) = self.get_current_part_block_range();

        for i in start_block..end_block {
            if !self.decoded_blocks.contains_key(&i) {
                return false;
            }
        }

        true
    }

    /// Get the data for the current part (for checksum validation)
    /// Returns None if part is not complete
    pub fn get_current_part_data(&self) -> Option<Vec<u8>> {
        if !self.part_based_mode || !self.is_current_part_complete() {
            return None;
        }

        let part_start_byte = self.current_part_index * self.part_size;
        let part_end_byte = ((self.current_part_index + 1) * self.part_size).min(self.metadata.size);
        let part_data_size = part_end_byte - part_start_byte;

        let mut result = Vec::with_capacity(part_data_size);
        let (start_block, end_block) = self.get_current_part_block_range();

        for i in start_block..end_block {
            if let Some(block) = self.decoded_blocks.get(&i) {
                result.extend_from_slice(block);
            } else {
                return None;
            }
        }

        // Trim to exact part size
        result.truncate(part_data_size);
        Some(result)
    }

    /// Move to the next part
    /// Returns true if moved to next part, false if already at last part
    pub fn move_to_next_part(&mut self) -> bool {
        if !self.part_based_mode || self.current_part_index >= self.total_parts - 1 {
            return false;
        }

        self.current_part_index += 1;
        // Clear decoded blocks and chunks for the new part
        self.decoded_blocks.clear();
        self.chunks.clear();

        true
    }

    /// Mark a part as completed and store its data
    /// This clears the decoded blocks for that part to save memory
    pub fn mark_part_completed(&mut self, part_index: usize) {
        if !self.part_based_mode || part_index >= self.total_parts {
            return;
        }

        // Get the current part data before clearing
        if part_index == self.current_part_index {
            if let Some(part_data) = self.get_current_part_data() {
                self.stored_part_data.insert(part_index, part_data);
                self.completed_parts.insert(part_index);

                // Clear decoded blocks for this part to save memory
                let (start_block, end_block) = self.get_current_part_block_range();
                for i in start_block..end_block {
                    self.decoded_blocks.remove(&i);
                }
            }
        }
    }

    /// Get the number of decoded blocks in the current part
    pub fn get_current_part_decoded_block_count(&self) -> usize {
        if !self.part_based_mode {
            return self.decoded_blocks.len();
        }

        let (start_block, end_block) = self.get_current_part_block_range();
        let mut count = 0;
        for i in start_block..end_block {
            if self.decoded_blocks.contains_key(&i) {
                count += 1;
            }
        }
        count
    }

    /// Get the total number of blocks in the current part
    pub fn get_current_part_total_block_count(&self) -> usize {
        if !self.part_based_mode {
            return self.metadata.total_source_blocks;
        }

        let (start_block, end_block) = self.get_current_part_block_range();
        end_block - start_block
    }

    /// Get part info
    pub fn get_part_info(&self) -> (bool, usize, usize, usize) {
        // Returns: (part_based_mode, current_part_index, total_parts, part_size)
        (
            self.part_based_mode,
            self.current_part_index,
            self.total_parts,
            self.part_size,
        )
    }

    /// Helper: Get the block range for the current part
    fn get_current_part_block_range(&self) -> (usize, usize) {
        let part_start_byte = self.current_part_index * self.part_size;
        let part_end_byte = ((self.current_part_index + 1) * self.part_size).min(self.metadata.size);

        let start_block = part_start_byte / self.metadata.block_size;
        let end_block = (part_end_byte + self.metadata.block_size - 1) / self.metadata.block_size; // ceil division
        let end_block = end_block.min(self.metadata.total_source_blocks);

        (start_block, end_block)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::FountainEncoder;
    use crate::types::FountainEncoderOptions;

    #[test]
    fn test_decoder_simple() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Keep adding chunks until decoded
        let mut chunks_needed = 0;
        while !decoder.is_complete() && chunks_needed < 100 {
            let chunk = encoder.generate_chunk();
            decoder.add_chunk(chunk);
            chunks_needed += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_decoder_progress() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        assert_eq!(decoder.get_progress(), 0.0);

        // Add some chunks
        for _ in 0..5 {
            let chunk = encoder.generate_chunk();
            decoder.add_chunk(chunk);
        }

        // Progress should have increased
        assert!(decoder.get_progress() > 0.0);
        assert!(decoder.get_progress() <= 1.0);
    }

    #[test]
    fn test_decoder_chunk_count() {
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default().with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        for i in 1..=5 {
            let chunk = encoder.generate_chunk();
            decoder.add_chunk(chunk);
            assert_eq!(decoder.get_received_chunk_count(), i);
        }
    }

    #[test]
    fn test_decoder_decoded_indices() {
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default().with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Add chunks until we decode at least one block
        for _ in 0..10 {
            let chunk = encoder.generate_chunk();
            decoder.add_chunk(chunk);
            if decoder.get_decoded_block_count() > 0 {
                break;
            }
        }

        let indices = decoder.get_decoded_block_indices();
        assert!(!indices.is_empty());

        // Check indices are sorted
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        assert_eq!(indices, sorted);
    }
}
