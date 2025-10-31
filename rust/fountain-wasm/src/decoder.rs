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

    // Deduplication and session management
    /// Composite keys of received chunks for deduplication (format: "seed:degree:firstIdx:lastIdx")
    received_chunk_keys: HashSet<String>,
    /// Current session ID for detecting session changes
    session_id: Option<u32>,
    /// Expected checksums for each part (part_index -> 4-byte checksum)
    expected_part_checksums: HashMap<usize, [u8; 4]>,

    // Throttling fields
    /// Queue of chunks waiting to be processed
    pending_chunks: Vec<DecodingChunk>,
    /// Threshold for triggering decode (number of non-duplicate chunks)
    decode_throttle_count: usize,
    /// Counter of chunks queued since last decode attempt
    chunks_since_last_decode: usize,
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
            received_chunk_keys: HashSet::new(),
            session_id: None,
            expected_part_checksums: HashMap::new(),
            pending_chunks: Vec::new(),
            decode_throttle_count: 10,
            chunks_since_last_decode: 0,
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
            received_chunk_keys: HashSet::new(),
            session_id: None,
            expected_part_checksums: HashMap::new(),
            pending_chunks: Vec::new(),
            decode_throttle_count: 10,
            chunks_since_last_decode: 0,
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

    /// Process all pending chunks in the queue
    /// Returns the number of new blocks decoded
    fn process_pending_chunks(&mut self) -> usize {
        if self.pending_chunks.is_empty() {
            return 0;
        }

        let blocks_before = self.decoded_blocks.len();

        // Move all pending chunks to the active chunks list
        while let Some(mut chunk) = self.pending_chunks.pop() {
            // Remove already-decoded blocks from this chunk
            for &decoded_idx in self.decoded_blocks.keys() {
                if chunk.indices.contains(&decoded_idx) {
                    xor_into(&mut chunk.data, &self.decoded_blocks[&decoded_idx]);
                    chunk.indices.remove(&decoded_idx);
                }
            }

            // Only add non-empty chunks
            if !chunk.indices.is_empty() {
                self.chunks.push(chunk);
            }
        }

        // Run belief propagation on all chunks
        self.belief_propagation();

        let blocks_after = self.decoded_blocks.len();
        blocks_after - blocks_before
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
        // Precondition: part_based_mode enabled and all parts stored
        if !self.part_based_mode || self.stored_part_data.len() != self.total_parts {
            return None;
        }

        // Concatenate all parts in order
        // The length precondition above guarantees all parts 0..total_parts are present
        let mut result = Vec::with_capacity(self.metadata.size);
        for i in 0..self.total_parts {
            // Safe to unwrap: length check above guarantees presence of all indices
            let part_data = self
                .stored_part_data
                .get(&i)
                .expect("part index guaranteed by length precondition");
            result.extend_from_slice(part_data);
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
        let part_end_byte =
            ((self.current_part_index + 1) * self.part_size).min(self.metadata.size);
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
        let part_end_byte =
            ((self.current_part_index + 1) * self.part_size).min(self.metadata.size);

        let start_block = part_start_byte / self.metadata.block_size;
        let end_block = (part_end_byte + self.metadata.block_size - 1) / self.metadata.block_size; // ceil division
        let end_block = end_block.min(self.metadata.total_source_blocks);

        (start_block, end_block)
    }

    /// Validate the current part's checksum against the expected value
    /// Returns a ChecksumValidationResult with the validation status and checksums
    pub fn validate_current_part_checksum(&self, expected_checksum_bytes: [u8; 4]) -> Option<crate::types::ChecksumValidationResult> {
        if !self.part_based_mode {
            return None;
        }

        // Get the current part data
        let part_data = self.get_current_part_data()?;

        // Compute the actual checksum
        let actual_checksum_bytes = crate::checksum::crc32(&part_data);

        // Convert both to hex strings for comparison and display
        let expected_hex = crate::checksum::crc32_to_hex(&expected_checksum_bytes);
        let actual_hex = crate::checksum::crc32_to_hex(&actual_checksum_bytes);

        // Compare
        let is_valid = actual_checksum_bytes == expected_checksum_bytes;

        Some(crate::types::ChecksumValidationResult {
            is_valid,
            expected_checksum: expected_hex,
            actual_checksum: actual_hex,
            part_index: self.current_part_index as u32,
        })
    }

    /// Validate the final decoded file's checksum against the expected value
    /// Takes the expected checksum as a hex string and computes the actual checksum
    /// Returns a FinalChecksumValidationResult with the validation status and checksums
    pub fn validate_final_checksum(&self, expected_checksum_hex: &str) -> Option<crate::types::FinalChecksumValidationResult> {
        // Get the decoded data
        let decoded_data = self.get_decoded_data()?;

        // Compute the actual checksum
        let actual_checksum_bytes = crate::checksum::crc32(&decoded_data);
        let actual_checksum_hex = crate::checksum::crc32_to_hex(&actual_checksum_bytes);

        // Compare (case-insensitive for hex strings)
        let is_valid = actual_checksum_hex.eq_ignore_ascii_case(expected_checksum_hex);

        Some(crate::types::FinalChecksumValidationResult {
            is_valid,
            expected_checksum: expected_checksum_hex.to_lowercase(),
            actual_checksum: actual_checksum_hex,
        })
    }

    // Session and deduplication management

    /// Set the current session ID and clear dedup cache if session changed
    pub fn set_session_id(&mut self, session_id: u32) {
        if self.session_id != Some(session_id) {
            // Session changed - clear dedup cache
            self.received_chunk_keys.clear();
            self.session_id = Some(session_id);
        }
    }

    /// Check if a chunk with the given key has already been received
    pub fn is_chunk_duplicate(&self, chunk_key: &str) -> bool {
        self.received_chunk_keys.contains(chunk_key)
    }

    /// Add a chunk key to the received set
    pub fn add_chunk_key(&mut self, chunk_key: String) {
        self.received_chunk_keys.insert(chunk_key);
    }

    /// Set the expected checksum for a specific part
    pub fn set_expected_part_checksum(&mut self, part_index: usize, checksum: [u8; 4]) {
        self.expected_part_checksums.insert(part_index, checksum);
    }

    /// Get the expected checksum for a specific part
    pub fn get_expected_part_checksum(&self, part_index: usize) -> Option<[u8; 4]> {
        self.expected_part_checksums.get(&part_index).copied()
    }

    /// Determine if a part should be validated for checksum
    /// Returns false for the last part (will validate entire file instead)
    pub fn should_validate_part(&self, part_index: usize) -> bool {
        // Don't validate the last part - will validate entire file instead
        part_index < self.total_parts - 1
    }

    /// High-level chunk processing with deduplication, throttling, and part validation
    /// Handles all orchestration: dedup check, chunk queuing, throttled decode, part completion check, validation
    pub fn process_chunk_with_validation(
        &mut self,
        chunk: FountainChunk,
        chunk_key: String,
    ) -> crate::types::ChunkProcessResult {
        // Check for duplicate chunk
        if self.is_chunk_duplicate(&chunk_key) {
            return crate::types::ChunkProcessResult {
                is_duplicate: true,
                blocks_decoded: 0,
                part_complete_info: None,
            };
        }

        // Record the chunk key
        self.add_chunk_key(chunk_key);
        self.received_chunk_count += 1;

        // Convert to internal format and add to pending queue
        let decoding_chunk = DecodingChunk {
            indices: chunk.indices.into_iter().collect(),
            data: chunk.data,
        };
        self.pending_chunks.push(decoding_chunk);

        // Increment throttle counter
        self.chunks_since_last_decode += 1;

        // Check if we should process pending chunks
        let should_process = self.chunks_since_last_decode >= self.decode_throttle_count;

        let blocks_decoded = if should_process {
            // Reset counter
            self.chunks_since_last_decode = 0;

            // Process all pending chunks
            self.process_pending_chunks()
        } else {
            0
        };

        // Check if part just completed and needs validation
        let mut part_complete_info = None;

        if self.part_based_mode && self.is_current_part_complete() {
            let part_index = self.current_part_index;
            let should_validate = self.should_validate_part(part_index);

            // Only validate if not the last part
            if should_validate {
                if let Some(expected_checksum_bytes) = self.get_expected_part_checksum(part_index) {
                    if let Some(validation_result) = self.validate_current_part_checksum(expected_checksum_bytes) {
                        // Mark part as completed (stores data and frees memory)
                        if validation_result.is_valid {
                            self.mark_part_completed(part_index);
                        }

                        part_complete_info = Some(crate::types::PartCompleteInfo {
                            is_valid: validation_result.is_valid,
                            expected_checksum: validation_result.expected_checksum,
                            actual_checksum: validation_result.actual_checksum,
                            current_part: part_index as u32,
                            total_parts: self.total_parts as u32,
                        });
                    }
                }
            } else {
                // For last part, just mark as completed without validation
                self.mark_part_completed(part_index);
            }
        }

        crate::types::ChunkProcessResult {
            is_duplicate: false,
            blocks_decoded,
            part_complete_info,
        }
    }

    /// Force processing of all pending chunks in the queue
    /// Returns the number of new blocks decoded
    /// Useful when transmission is complete or when checking for completion without waiting for throttle threshold
    pub fn flush_pending_chunks(&mut self) -> usize {
        if self.pending_chunks.is_empty() {
            return 0;
        }

        // Reset throttle counter since we're forcing a flush
        self.chunks_since_last_decode = 0;

        // Process all pending chunks
        self.process_pending_chunks()
    }

    /// Get the number of pending chunks waiting to be processed
    pub fn get_pending_chunk_count(&self) -> usize {
        self.pending_chunks.len()
    }

    /// Set the decode throttle threshold (number of chunks before triggering decode)
    pub fn set_decode_throttle_count(&mut self, count: usize) {
        self.decode_throttle_count = count;
    }

    /// Get the current decode throttle threshold
    pub fn get_decode_throttle_count(&self) -> usize {
        self.decode_throttle_count
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
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Keep adding chunks until decoded
        let mut chunks_needed = 0;
        while !decoder.is_complete() && chunks_needed < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
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
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        assert_eq!(decoder.get_progress(), 0.0);

        // Add some chunks
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
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
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        for i in 1..=5 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                assert_eq!(decoder.get_received_chunk_count(), i);
            }
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
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Add chunks until we decode at least one block
        for _ in 0..10 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                if decoder.get_decoded_block_count() > 0 {
                    break;
                }
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
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.size, 7); // Original size
        assert_eq!(metadata.block_size, 4);
        assert_eq!(metadata.total_source_blocks, 2); // ceil(7/4) = 2

        let mut decoder = FountainDecoder::new(metadata);

        // Decode until complete
        let mut chunks_needed = 0;
        while !decoder.is_complete() && chunks_needed < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_needed += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Verify exact length matches original (not padded)
        assert_eq!(
            decoded.len(),
            7,
            "Decoded data should be exactly 7 bytes, not padded to block size"
        );
        assert_eq!(
            decoded, data,
            "Decoded data should exactly match original data"
        );
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
            false, 0, None,
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
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
            }

            // Mark part complete and move to next
            if let Some(part_data) = decoder.get_current_part_data() {
                decoder.mark_part_completed(part_idx);

                // Verify part size (last part may be smaller)
                if part_idx < total_parts - 1 {
                    assert_eq!(
                        part_data.len(),
                        part_size,
                        "Non-final part should be exactly part_size"
                    );
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
        assert_eq!(
            decoded, data,
            "Decoded data should exactly match original data"
        );
    }

    #[test]
    fn test_flush_pending_chunks_processes_queued_chunks() {
        // Create a small file that can be decoded with just a few chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Generate and queue 5 chunks (below default threshold of 10)
        let mut chunks = Vec::new();
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                chunks.push(chunk);
            }
        }

        // Process chunks using process_chunk_with_validation
        let mut decoded_before_flush = 0;
        for chunk in chunks {
            let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                   chunk.indices.first().unwrap_or(&0),
                                   chunk.indices.last().unwrap_or(&0));
            let result = decoder.process_chunk_with_validation(chunk, chunk_key);
            decoded_before_flush = result.blocks_decoded;
        }

        // Verify chunks are pending (not processed yet due to throttle)
        let pending_count = decoder.get_pending_chunk_count();
        assert!(pending_count > 0, "Should have pending chunks below threshold");

        // Flush pending chunks
        let blocks_decoded = decoder.flush_pending_chunks();

        // Verify chunks were processed
        assert!(blocks_decoded > 0 || decoded_before_flush > 0, "Should have decoded blocks after flush");
        assert_eq!(decoder.get_pending_chunk_count(), 0, "No pending chunks after flush");
    }

    #[test]
    fn test_flush_required_to_complete_decoding() {
        // Create a very small file that can be decoded with 2-3 chunks
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default().with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Set a high throttle threshold so we won't trigger automatic processing
        decoder.set_decode_throttle_count(20);

        // Generate enough chunks to complete decoding (but fewer than threshold)
        let mut chunk_count = 0;
        while chunk_count < 10 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
                chunk_count += 1;
            }
        }

        // Verify not complete yet (chunks are pending)
        assert!(!decoder.is_complete(), "Should not be complete before flush");
        assert!(decoder.get_pending_chunk_count() > 0, "Should have pending chunks");

        // Flush pending chunks - this should complete the decoding
        let blocks_decoded = decoder.flush_pending_chunks();
        assert!(blocks_decoded > 0, "Flush should decode blocks");

        // Verify decoding is now complete
        assert!(decoder.is_complete(), "Should be complete after flush");

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data, "Decoded data should match original");
    }

    #[test]
    fn test_flush_empty_queue_returns_zero() {
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default().with_block_size(2);

        let encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Flush without adding any chunks
        let blocks_decoded = decoder.flush_pending_chunks();
        assert_eq!(blocks_decoded, 0, "Flushing empty queue should return 0");
        assert_eq!(decoder.get_pending_chunk_count(), 0, "Pending count should be 0");
    }

    #[test]
    fn test_flush_resets_throttle_counter() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Set throttle to 5 chunks
        decoder.set_decode_throttle_count(5);

        // Add 3 chunks (below threshold)
        for _ in 0..3 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify pending
        assert!(decoder.get_pending_chunk_count() > 0, "Should have pending chunks");

        // Flush (should reset counter)
        decoder.flush_pending_chunks();

        // Add 3 more chunks (should also be below threshold after reset)
        for _ in 0..3 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify new chunks are also pending (counter was reset)
        let pending = decoder.get_pending_chunk_count();
        assert!(pending > 0 && pending <= 3, "Counter should have been reset after flush");
    }

    #[test]
    fn test_get_pending_chunk_count_accuracy() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Set high threshold to keep chunks pending
        decoder.set_decode_throttle_count(20);

        // Initially 0
        assert_eq!(decoder.get_pending_chunk_count(), 0);

        // Add chunks and verify count increases
        for i in 1..=5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
                assert_eq!(decoder.get_pending_chunk_count(), i,
                          "Pending count should match chunks added");
            }
        }

        // Flush and verify count is 0
        decoder.flush_pending_chunks();
        assert_eq!(decoder.get_pending_chunk_count(), 0, "Count should be 0 after flush");
    }

    #[test]
    fn test_set_get_throttle_count() {
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default().with_block_size(2);

        let encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Default should be 10
        assert_eq!(decoder.get_decode_throttle_count(), 10);

        // Set to different values
        decoder.set_decode_throttle_count(5);
        assert_eq!(decoder.get_decode_throttle_count(), 5);

        decoder.set_decode_throttle_count(100);
        assert_eq!(decoder.get_decode_throttle_count(), 100);

        decoder.set_decode_throttle_count(1);
        assert_eq!(decoder.get_decode_throttle_count(), 1);
    }

    #[test]
    fn test_throttle_triggers_at_exact_threshold() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Set threshold to 3
        decoder.set_decode_throttle_count(3);

        // Add 2 chunks (below threshold)
        for _ in 0..2 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Should have 2 pending
        let pending_before = decoder.get_pending_chunk_count();
        assert!(pending_before >= 2, "Should have at least 2 pending chunks");

        // Add 3rd chunk (exactly at threshold - should trigger)
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                   chunk.indices.first().unwrap_or(&0),
                                   chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Pending count should be 0 or very low (processed at threshold)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(pending_after < pending_before, "Processing should have occurred at threshold");
    }
}
