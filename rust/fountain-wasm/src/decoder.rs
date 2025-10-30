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
    /// Original received chunks (never modified, used to recreate working set)
    received_chunks: Vec<FountainChunk>,
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
            received_chunks: Vec::new(),
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
            received_chunks: Vec::new(),
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

        // Store the original chunk (never modified)
        self.received_chunks.push(chunk);

        // Recreate working set and run belief propagation
        self.attempt_decode()
    }

    /// Attempt to decode by recreating working set from original chunks
    /// This matches the JavaScript implementation's behavior
    /// Returns true if decoding is now complete
    fn attempt_decode(&mut self) -> bool {
        // Recreate working chunks from original received chunks (like JavaScript)
        let mut working_chunks: Vec<DecodingChunk> = self.received_chunks
            .iter()
            .map(|chunk| DecodingChunk {
                indices: chunk.indices.iter().copied().collect(),
                data: chunk.data.clone(),
            })
            .collect();

        let mut decoded = HashMap::new();

        // Iteratively decode using belief propagation (peeling decoder)
        let mut made_progress = true;
        while made_progress {
            made_progress = false;

            // Find chunks with exactly one active index and collect decoding info
            let mut to_decode = Vec::new();
            for (i, chunk) in working_chunks.iter().enumerate() {
                if chunk.indices.len() == 1 {
                    let block_idx = *chunk.indices.iter().next().unwrap();
                    if !decoded.contains_key(&block_idx) {
                        to_decode.push((i, block_idx, chunk.data.clone()));
                    }
                }
            }

            // Process decoded blocks
            for (_chunk_idx, block_idx, decoded_block) in to_decode {
                decoded.insert(block_idx, decoded_block.clone());
                made_progress = true;

                // XOR this newly decoded block out of all chunks
                for j in 0..working_chunks.len() {
                    if working_chunks[j].indices.contains(&block_idx) {
                        xor_into(&mut working_chunks[j].data, &decoded_block);
                        working_chunks[j].indices.remove(&block_idx);
                    }
                }
            }
        }

        // Update decoded blocks
        self.decoded_blocks = decoded;

        // Return true if decoding made progress
        self.decoded_blocks.len() == self.metadata.total_source_blocks
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

        // Truncate to exact file size (handles last part padding)
        result.truncate(self.metadata.size);

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

        // Calculate offset within first block where this part starts
        let first_block_start_byte = start_block * self.metadata.block_size;
        let offset_in_first_block = part_start_byte - first_block_start_byte;

        // Concatenate blocks
        for i in start_block..end_block {
            if let Some(block) = self.decoded_blocks.get(&i) {
                if i == start_block && offset_in_first_block > 0 {
                    // First block: skip bytes before part starts
                    result.extend_from_slice(&block[offset_in_first_block..]);
                } else {
                    // Other blocks: copy entire block
                    result.extend_from_slice(block);
                }
            } else {
                return None;
            }
        }

        // Truncate to exact part size (handles end boundary and padding)
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
        // Clear decoded blocks and received chunks for the new part
        self.decoded_blocks.clear();
        self.received_chunks.clear();

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
            None,
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
            None,
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
            None,
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
            None,
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

    #[test]
    fn test_decoder_non_aligned_file_size() {
        // Test file size that's not a multiple of block_size
        // This ensures truncation works correctly for the last block
        let data = vec![1, 2, 3, 4, 5, 6, 7]; // 7 bytes
        let block_size = 4; // Will create 2 blocks (4 bytes + 3 bytes padded to 4)
        let options = FountainEncoderOptions::default().with_block_size(block_size);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.size, 7); // Original size
        assert_eq!(metadata.block_size, 4);
        assert_eq!(metadata.total_source_blocks, 2); // ceil(7/4) = 2

        let mut decoder = FountainDecoder::new(metadata);

        // Decode until complete
        let mut chunks_needed = 0;
        while !decoder.is_complete() && chunks_needed < 100 {
            let chunk = encoder.generate_chunk();
            decoder.add_chunk(chunk);
            chunks_needed += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Verify exact length matches original (not padded)
        assert_eq!(decoded.len(), 7, "Decoded data should be exactly 7 bytes, not padded to block size");
        assert_eq!(decoded, data, "Decoded data should exactly match original data");
    }

    #[test]
    fn test_part_based_mode_non_aligned_sizes() {
        // Test part-based mode with file size not aligned to part_size or block_size
        // File: 1337 bytes, Block: 400 bytes, Part: 512 bytes
        let file_size = 1337;
        let block_size = 400;
        let part_size = 512;

        let mut data = Vec::with_capacity(file_size);
        for i in 0..file_size {
            data.push((i % 256) as u8); // Sequential pattern
        }

        let options = FountainEncoderOptions::default().with_block_size(block_size);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.size, file_size);
        assert_eq!(metadata.block_size, block_size);

        // Create part-based decoder
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);

        // Decode all parts
        let (_, _, total_parts, _) = decoder.get_part_info();
        assert_eq!(total_parts, 3); // ceil(1337/512) = 3 parts

        for part_idx in 0..total_parts {
            // Decode current part
            while !decoder.is_current_part_complete() {
                let chunk = encoder.generate_chunk();
                decoder.add_chunk(chunk);
            }

            // Mark part complete and move to next
            if let Some(part_data) = decoder.get_current_part_data() {
                decoder.mark_part_completed(part_idx);

                // Verify part size (last part may be smaller)
                if part_idx < total_parts - 1 {
                    assert_eq!(part_data.len(), part_size, "Non-final part should be exactly part_size");
                } else {
                    let expected_last_part_size = file_size - (part_idx * part_size);
                    assert_eq!(
                        part_data.len(),
                        expected_last_part_size,
                        "Last part should be exactly the remaining bytes: {} - ({} * {}) = {}",
                        file_size,
                        part_idx,
                        part_size,
                        expected_last_part_size
                    );
                }
            }

            if part_idx < total_parts - 1 {
                decoder.move_to_next_part();
            }
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Verify exact length and content
        assert_eq!(
            decoded.len(),
            file_size,
            "Decoded data should be exactly {} bytes (original size), not padded",
            file_size
        );
        assert_eq!(decoded, data, "Decoded data should exactly match original data");
    }
}
