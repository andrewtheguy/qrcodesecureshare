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
    /// Whether the first decode attempt has been made for current part
    first_decode_attempted: bool,
    /// Adaptive throttle percentage for incremental decodes (default 2%)
    adaptive_throttle_percentage: f64,
    /// Minimum chunk threshold for incremental decodes (default 10)
    min_incremental_chunks: usize,
    /// Number of chunks received for the current part (in part-based mode) or entire file
    chunks_received_for_current_part: usize,
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
            first_decode_attempted: false,
            adaptive_throttle_percentage: 0.02,
            min_incremental_chunks: 10,
            chunks_received_for_current_part: 0,
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
            first_decode_attempted: false,
            adaptive_throttle_percentage: 0.02,
            min_incremental_chunks: 10,
            chunks_received_for_current_part: 0,
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

        // Reset first decode flag and counters for the new part
        self.first_decode_attempted = false;
        self.chunks_since_last_decode = 0;
        self.chunks_received_for_current_part = 0;

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
        self.chunks_received_for_current_part += 1;

        // Convert to internal format and add to pending queue
        let decoding_chunk = DecodingChunk {
            indices: chunk.indices.into_iter().collect(),
            data: chunk.data,
        };
        self.pending_chunks.push(decoding_chunk);

        // Increment throttle counter
        self.chunks_since_last_decode += 1;

        // Get total chunks received for current part
        let total_chunks_current_part = self.chunks_received_for_current_part;

        // Determine if we should process pending chunks
        // Strategy:
        // 1. At 10 total chunks: early decode for error detection
        // 2. At 110% total chunks: first real decode with high success probability
        // 3. After 110%: incremental decodes at max(2%, 10 chunks) since last decode
        let should_process = if !self.first_decode_attempted {
            // Before first decode at 110%
            let required_chunks_110 = if self.part_based_mode {
                let blocks_in_part = self.get_current_part_total_block_count();
                (blocks_in_part as f64 * 1.10).ceil() as usize
            } else {
                (self.metadata.total_source_blocks as f64 * 1.10).ceil() as usize
            };

            // Trigger at 10 total chunks (early error detection) OR at 110% total chunks
            total_chunks_current_part == 10 || total_chunks_current_part >= required_chunks_110
        } else {
            // After first decode at 110%: incremental decodes at 2% or 10 chunks since last decode
            let total_blocks = if self.part_based_mode {
                self.get_current_part_total_block_count()
            } else {
                self.metadata.total_source_blocks
            };

            let percentage_threshold = (total_blocks as f64 * self.adaptive_throttle_percentage).ceil() as usize;
            let threshold = percentage_threshold.max(self.min_incremental_chunks);

            self.chunks_since_last_decode >= threshold
        };

        let blocks_decoded = if should_process {
            // Mark first decode as attempted only when we reach 110% threshold
            if !self.first_decode_attempted {
                let required_chunks_110 = if self.part_based_mode {
                    let blocks_in_part = self.get_current_part_total_block_count();
                    (blocks_in_part as f64 * 1.10).ceil() as usize
                } else {
                    (self.metadata.total_source_blocks as f64 * 1.10).ceil() as usize
                };

                if total_chunks_current_part >= required_chunks_110 {
                    self.first_decode_attempted = true;
                }
            }

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

    /// Set the adaptive throttle percentage for incremental decodes
    pub fn set_adaptive_throttle_percentage(&mut self, percentage: f64) {
        self.adaptive_throttle_percentage = percentage.clamp(0.0, 1.0);
    }

    /// Get the adaptive throttle percentage
    pub fn get_adaptive_throttle_percentage(&self) -> f64 {
        self.adaptive_throttle_percentage
    }

    /// Set the minimum incremental chunk threshold
    pub fn set_min_incremental_chunks(&mut self, count: usize) {
        self.min_incremental_chunks = count;
    }

    /// Get the minimum incremental chunk threshold
    pub fn get_min_incremental_chunks(&self) -> usize {
        self.min_incremental_chunks
    }

    /// Process a binary chunk through the complete pipeline
    ///
    /// This method handles all aspects of chunk processing:
    /// 1. Parse binary chunk
    /// 2. Validate checksum
    /// 3. Create chunk key for deduplication
    /// 4. Handle part metadata (if present)
    /// 5. Process chunk with validation
    /// 6. Gather all progress metrics
    /// 7. Handle completion (reconstruction + validation)
    ///
    /// Returns a comprehensive result with all state information
    pub fn process_binary_chunk(
        &mut self,
        binary_data: &[u8],
        total_source_blocks: usize,
        final_checksum: &str,
    ) -> crate::types::BinaryChunkProcessResult {
        use crate::types::{BinaryChunkProcessResult, ChunkStatus, CompletionData};

        // Helper to create error result (doesn't capture self)
        fn make_error_result(status: ChunkStatus, seed: u32, decoded_count: usize, progress: f64) -> BinaryChunkProcessResult {
            BinaryChunkProcessResult {
                status,
                seed,
                decoded_block_count: decoded_count,
                overall_progress: progress,
                part_progress: 0.0,
                is_complete: false,
                decoded_block_indices: vec![],
                current_part_index: None,
                total_parts: None,
                current_part_decoded_blocks: None,
                current_part_total_blocks: None,
                part_complete_info: None,
                completion_data: None,
            }
        }

        // 1. Parse binary chunk
        let parsed = match crate::parser::parse_binary_chunk(binary_data, self.part_based_mode, total_source_blocks) {
            Ok(p) => p,
            Err(e) => {
                let decoded_count = self.decoded_blocks.len();
                let progress = self.get_progress();
                return make_error_result(ChunkStatus::ParseError { message: e }, 0, decoded_count, progress);
            }
        };

        let chunk_seed = parsed.chunk.seed;

        // 2. Validate checksum
        let checksum_payload = &binary_data[2..parsed.checksum_start];
        let computed = crate::checksum::crc32(checksum_payload);
        let computed_hex = crate::checksum::crc32_to_hex(&computed);

        // Extract stored checksum from binary data
        if parsed.checksum_start + 4 > binary_data.len() {
            let decoded_count = self.decoded_blocks.len();
            let progress = self.get_progress();
            return make_error_result(
                ChunkStatus::ChecksumError {
                    message: format!("Checksum position {} + 4 exceeds data length {}", parsed.checksum_start, binary_data.len())
                },
                chunk_seed,
                decoded_count,
                progress
            );
        }
        let stored_bytes = &binary_data[parsed.checksum_start..parsed.checksum_start + 4];
        let stored_hex = crate::checksum::crc32_to_hex(stored_bytes.try_into().unwrap_or(&[0,0,0,0]));

        if computed_hex != stored_hex {
            let decoded_count = self.decoded_blocks.len();
            let progress = self.get_progress();
            return make_error_result(
                ChunkStatus::ChecksumError {
                    message: format!("Computed: {}, Stored: {}", computed_hex, stored_hex)
                },
                chunk_seed,
                decoded_count,
                progress
            );
        }

        // 3. Create chunk key for deduplication
        let chunk_key = crate::parser::create_chunk_key(
            parsed.chunk.seed,
            parsed.chunk.degree,
            &parsed.chunk.indices
        );

        // 4. Handle part metadata if present
        if let Some(ref meta) = parsed.part_metadata {
            self.set_expected_part_checksum(meta.current_part as usize, meta.part_checksum);
        }

        // 5. Process chunk with validation (includes throttling and deduplication)
        let process_result = self.process_chunk_with_validation(parsed.chunk, chunk_key);

        // 6. Handle duplicate
        if process_result.is_duplicate {
            let decoded_count = self.decoded_blocks.len();
            let progress = self.get_progress();
            return make_error_result(ChunkStatus::Duplicate, chunk_seed, decoded_count, progress);
        }

        // 7. Gather all state
        let decoded_block_count = self.get_decoded_block_count();
        let overall_progress = self.get_progress();
        let is_complete = self.is_complete();
        let decoded_block_indices = self.get_decoded_block_indices();

        // 8. Calculate part progress
        let part_progress = if self.part_based_mode {
            let decoded = self.get_current_part_decoded_block_count();
            let total = self.get_current_part_total_block_count();
            if total > 0 {
                decoded as f64 / total as f64
            } else {
                0.0
            }
        } else {
            overall_progress
        };

        // 9. Get part info if in part mode
        let (current_part_index, total_parts, current_part_decoded_blocks, current_part_total_blocks) =
            if self.part_based_mode {
                let (_, idx, total, _) = self.get_part_info();
                (
                    Some(idx as u32),
                    Some(total as u32),
                    Some(self.get_current_part_decoded_block_count()),
                    Some(self.get_current_part_total_block_count()),
                )
            } else {
                (None, None, None, None)
            };

        // 10. Handle completion
        let completion_data = if is_complete {
            if let Some(data) = self.get_decoded_data() {
                let validation = self.validate_final_checksum(final_checksum);
                Some(CompletionData {
                    data,
                    integrity_ok: validation.as_ref().map(|v| v.is_valid).unwrap_or(false),
                    expected_checksum: validation
                        .as_ref()
                        .map(|v| v.expected_checksum.clone())
                        .unwrap_or_default(),
                    actual_checksum: validation
                        .as_ref()
                        .map(|v| v.actual_checksum.clone())
                        .unwrap_or_default(),
                })
            } else {
                None
            }
        } else {
            None
        };

        BinaryChunkProcessResult {
            status: ChunkStatus::Processed,
            seed: chunk_seed,
            decoded_block_count,
            overall_progress,
            part_progress,
            is_complete,
            decoded_block_indices,
            current_part_index,
            total_parts,
            current_part_decoded_blocks,
            current_part_total_blocks,
            part_complete_info: process_result.part_complete_info,
            completion_data,
        }
    }
}


