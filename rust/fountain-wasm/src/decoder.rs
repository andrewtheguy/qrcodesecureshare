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

        // Reset first decode flag for the new part
        self.first_decode_attempted = false;
        self.chunks_since_last_decode = 0;

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

        // Determine if we should process pending chunks
        let should_process = if !self.first_decode_attempted {
            // First decode: wait for 110% of required chunks
            let required_chunks = if self.part_based_mode {
                let blocks_in_part = self.get_current_part_total_block_count();
                (blocks_in_part as f64 * 1.10).ceil() as usize
            } else {
                (self.metadata.total_source_blocks as f64 * 1.10).ceil() as usize
            };

            self.chunks_since_last_decode >= required_chunks
        } else {
            // Subsequent decodes: 2% or 10 chunks, whichever is greater
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
            // Mark first decode as attempted
            if !self.first_decode_attempted {
                self.first_decode_attempted = true;
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
        // With adaptive strategy: 2 blocks need ceil(2 * 1.10) = 3 chunks for first decode
        // Then max(ceil(2 * 0.02), 10) = 10 chunks for subsequent decodes
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
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Add 5 chunks: First 3 trigger first decode, next 2 are pending (need 10 for next)
        let mut chunks = Vec::new();
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                chunks.push(chunk);
            }
        }

        // Process chunks using process_chunk_with_validation
        for chunk in chunks {
            let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                   chunk.indices.first().unwrap_or(&0),
                                   chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have some blocks decoded from first decode (at 3 chunks)
        // Check by seeing if decoder has decoded blocks
        let decoded_blocks = decoder.get_decoded_block_count();
        assert!(decoded_blocks > 0, "First decode should have happened at 3 chunks (decoded {} blocks)", decoded_blocks);

        // Should have 2 pending chunks (need 10 for next decode)
        let pending_count = decoder.get_pending_chunk_count();
        assert!(pending_count > 0, "Should have pending chunks (need 10 for next decode)");

        // Flush pending chunks
        decoder.flush_pending_chunks();

        // Verify flush processed pending chunks
        assert_eq!(decoder.get_pending_chunk_count(), 0, "No pending chunks after flush");
    }

    #[test]
    fn test_flush_required_to_complete_decoding() {
        // Create a very small file that can be decoded with 2-3 chunks
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.02), 10) = 10 for next decode
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
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Add 7 chunks: First 3 trigger first decode, remaining 4 are pending (need 10)
        // This should have enough data to complete, but chunks are pending
        let mut chunk_count = 0;
        while chunk_count < 7 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
                chunk_count += 1;
            }
        }

        // May or may not be complete yet depending on chunks received
        // But should have pending chunks (need 10 for next automatic decode)
        let pending = decoder.get_pending_chunk_count();
        assert!(pending > 0, "Should have pending chunks (need 10 for next decode, only added 4 more)");

        // Flush pending chunks - this processes all pending
        decoder.flush_pending_chunks();

        // After flush, should have no pending
        assert_eq!(decoder.get_pending_chunk_count(), 0, "No pending after flush");

        // Should be complete or very close
        if !decoder.is_complete() {
            // Add a few more and flush again
            for _ in 0..5 {
                if let Some(chunk) = encoder.generate_chunk() {
                    let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                           chunk.indices.first().unwrap_or(&0),
                                           chunk.indices.last().unwrap_or(&0));
                    decoder.process_chunk_with_validation(chunk, chunk_key);
                }
            }
            decoder.flush_pending_chunks();
        }

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
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.02), 10) = 10 for subsequent decodes
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
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Add 5 chunks: First 3 trigger first decode, next 2 are pending
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify pending (need 10 for next decode, only added 2 more)
        assert!(decoder.get_pending_chunk_count() > 0, "Should have 2 pending chunks");

        // Flush (should reset counter and process pending)
        decoder.flush_pending_chunks();
        assert_eq!(decoder.get_pending_chunk_count(), 0, "No pending after flush");

        // Add 5 more chunks (should also start pending - need 10 total)
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify new chunks are pending (counter was reset)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(pending_after > 0, "Counter should have been reset, new chunks pending");
        assert!(pending_after <= 5, "Should have at most 5 new pending chunks");
    }

    #[test]
    fn test_get_pending_chunk_count_accuracy() {
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.02), 10) = 10 for subsequent decodes
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
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Initially 0
        assert_eq!(decoder.get_pending_chunk_count(), 0);

        // Add chunks and verify count behavior with adaptive strategy
        // Chunks 1-2: pending (count: 1, 2)
        for i in 1..=2 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
                assert_eq!(decoder.get_pending_chunk_count(), i,
                          "Pending count should be {} before first decode", i);
            }
        }

        // Chunk 3: triggers first decode, count resets to 0
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                   chunk.indices.first().unwrap_or(&0),
                                   chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
            assert_eq!(decoder.get_pending_chunk_count(), 0,
                      "Count should be 0 after first decode at 3 chunks");
        }

        // Chunks 4-5: pending again (count: 1, 2)
        for i in 1..=2 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}", chunk.seed, chunk.degree,
                                       chunk.indices.first().unwrap_or(&0),
                                       chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
                assert_eq!(decoder.get_pending_chunk_count(), i,
                          "Pending count should be {} after first decode", i);
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

    // ========================================
    // process_binary_chunk() Tests
    // ========================================

    #[test]
    fn test_process_binary_chunk_successful() {
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Generate a chunk and serialize it to binary
        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process binary chunk
            let result = decoder.process_binary_chunk(
                &binary_data,
                total_source_blocks,
                "",
            );

            // Should be processed successfully
            match result.status {
                crate::types::ChunkStatus::Processed => {
                    // Seed can be any value including 0
                    assert!(result.overall_progress >= 0.0 && result.overall_progress <= 1.0);
                    assert!(!result.is_complete); // Not complete after one chunk
                }
                _ => panic!("Expected Processed status, got: {:?}", result.status),
            }
        }
    }

    #[test]
    fn test_process_binary_chunk_parse_error() {
        let data = vec![1, 2, 3, 4];
        let options = FountainEncoderOptions::default();

        let encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Create malformed binary data (too short)
        let invalid_data = vec![0u8; 5];

        let result = decoder.process_binary_chunk(
            &invalid_data,
            total_source_blocks,
            "",
        );

        // Should return parse error
        match result.status {
            crate::types::ChunkStatus::ParseError { message } => {
                assert!(!message.is_empty());
            }
            _ => panic!("Expected ParseError status"),
        }
    }

    #[test]
    fn test_process_binary_chunk_checksum_error() {
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let mut binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Corrupt the checksum bytes (last 4 bytes)
            let len = binary_data.len();
            if len > 4 {
                binary_data[len - 4] ^= 0xFF;
            }

            let result = decoder.process_binary_chunk(
                &binary_data,
                total_source_blocks,
                "",
            );

            // Should return checksum error
            match result.status {
                crate::types::ChunkStatus::ChecksumError { message } => {
                    assert!(!message.is_empty());
                }
                _ => panic!("Expected ChecksumError status, got {:?}", result.status),
            }
        }
    }

    #[test]
    fn test_process_binary_chunk_duplicate() {
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk twice
            let result1 = decoder.process_binary_chunk(
                &binary_data,
                total_source_blocks,
                "",
            );

            // First should be processed
            match result1.status {
                crate::types::ChunkStatus::Processed => {}
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Flush to ensure it's processed
            decoder.flush_pending_chunks();

            let result2 = decoder.process_binary_chunk(
                &binary_data,
                total_source_blocks,
                "",
            );

            // Second should be duplicate
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!("Expected Duplicate status on second chunk, got {:?}", result2.status),
            }
        }
    }

    #[test]
    fn test_process_binary_chunk_completion() {
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
        let total_source_blocks = metadata.total_source_blocks;

        // Compute expected checksum
        let expected_checksum = crate::checksum::crc32_to_hex(&crate::checksum::crc32(&data));

        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1); // Process every chunk

        let mut last_result = None;
        let mut chunks_added = 0;

        // Keep adding chunks until complete
        while chunks_added < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

                let result = decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    &expected_checksum,
                );

                last_result = Some(result);

                if last_result.as_ref().unwrap().is_complete {
                    break;
                }
            }
            chunks_added += 1;
        }

        // Should be complete
        let result = last_result.unwrap();
        assert!(result.is_complete);
        assert_eq!(result.overall_progress, 1.0);

        // Should have completion data
        assert!(result.completion_data.is_some());

        let completion_data = result.completion_data.unwrap();
        assert_eq!(completion_data.data, data);
        assert!(completion_data.integrity_ok);
        assert_eq!(completion_data.expected_checksum, expected_checksum);
        assert_eq!(completion_data.actual_checksum, expected_checksum);
    }

    #[test]
    fn test_process_binary_chunk_part_based_mode() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let options = FountainEncoderOptions::default().with_block_size(4);
        let part_size = 6; // 2 parts: [1,2,3,4,5,6] and [7,8,9,10,11,12]

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);
        decoder.set_decode_throttle_count(1);

        // Get part checksums from encoder
        encoder.set_part_checksums(vec![]); // Trigger calculation
        let part_checksums = encoder.get_part_checksums();

        // Convert checksum strings to bytes and set them
        for (idx, checksum_hex) in part_checksums.iter().enumerate() {
            // Parse hex string to bytes
            let mut checksum_array = [0u8; 4];
            for (i, chunk) in checksum_hex.as_bytes().chunks(2).take(4).enumerate() {
                let byte_str = std::str::from_utf8(chunk).unwrap();
                checksum_array[i] = u8::from_str_radix(byte_str, 16).unwrap();
            }
            decoder.set_expected_part_checksum(idx, checksum_array);
        }

        // Process chunks for first part
        let mut result = None;
        for _ in 0..50 {
            if let Some(chunk) = encoder.generate_chunk() {
                let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, true);

                result = Some(decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    "",
                ));

                if result.as_ref().unwrap().part_complete_info.is_some() {
                    break;
                }
            }
        }

        // Should have part completion info
        let last_result = result.unwrap();
        assert!(last_result.current_part_index.is_some());
        assert_eq!(last_result.current_part_index.unwrap(), 0);

        if last_result.part_complete_info.is_some() {
            let part_info = last_result.part_complete_info.unwrap();
            assert_eq!(part_info.current_part, 0);
            assert!(part_info.is_valid);
        }
    }

    #[test]
    fn test_process_binary_chunk_progress_tracking() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1);

        let mut last_progress = 0.0;

        // Add chunks and verify progress increases
        for _ in 0..10 {
            if let Some(chunk) = encoder.generate_chunk() {
                let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

                let result = decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    "",
                );

                // Progress should be between 0 and 1
                assert!(result.overall_progress >= 0.0 && result.overall_progress <= 1.0);

                // Progress should not decrease
                assert!(result.overall_progress >= last_progress);

                last_progress = result.overall_progress;

                // Decoded block count should match progress
                assert_eq!(
                    result.decoded_block_count,
                    result.decoded_block_indices.len()
                );

                if result.is_complete {
                    assert_eq!(result.overall_progress, 1.0);
                    break;
                }
            }
        }
    }

    #[test]
    fn test_process_binary_chunk_integrity_check_fail() {
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
        let total_source_blocks = metadata.total_source_blocks;

        // Use WRONG checksum
        let wrong_checksum = "deadbeef";

        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1);

        // Process until complete
        for _ in 0..100 {
            if let Some(chunk) = encoder.generate_chunk() {
                let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

                let result = decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    wrong_checksum,
                );

                if result.is_complete {
                    // Should have completion data but integrity should fail
                    assert!(result.completion_data.is_some());
                    let completion_data = result.completion_data.unwrap();
                    assert!(!completion_data.integrity_ok);
                    assert_eq!(completion_data.expected_checksum, wrong_checksum);
                    assert_ne!(completion_data.actual_checksum, wrong_checksum);
                    break;
                }
            }
        }
    }

    // ========================================
    // Deduplication Tests
    // ========================================

    #[test]
    fn test_deduplication_multiple_duplicates() {
        // Test that the same chunk can be sent multiple times and is detected as duplicate each time
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk 5 times
            for i in 0..5 {
                let result = decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    "",
                );

                if i == 0 {
                    // First should be processed
                    match result.status {
                        crate::types::ChunkStatus::Processed => {},
                        _ => panic!("Expected Processed status on first chunk, got {:?}", result.status),
                    }
                } else {
                    // All subsequent should be duplicates
                    match result.status {
                        crate::types::ChunkStatus::Duplicate => {},
                        _ => panic!("Expected Duplicate status on chunk #{}, got {:?}", i, result.status),
                    }
                }
            }
        }
    }

    #[test]
    fn test_deduplication_does_not_increment_received_count() {
        // Test that duplicates don't increment the received_chunk_count
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk 3 times
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(decoder.get_received_chunk_count(), 1, "First chunk should increment count to 1");

            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(decoder.get_received_chunk_count(), 1, "Duplicate should not increment count");

            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(decoder.get_received_chunk_count(), 1, "Second duplicate should not increment count");
        }
    }

    #[test]
    fn test_deduplication_session_id_change_clears_cache() {
        // Test that changing session ID clears the dedup cache
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Set initial session ID
        decoder.set_session_id(100);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process chunk
            let result1 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result1.status {
                crate::types::ChunkStatus::Processed => {},
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Process same chunk again - should be duplicate
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {},
                _ => panic!("Expected Duplicate status before session change"),
            }

            // Change session ID
            decoder.set_session_id(200);

            // Process same chunk again - should be processed (not duplicate) after session change
            let result3 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result3.status {
                crate::types::ChunkStatus::Processed => {},
                _ => panic!("Expected Processed status after session change, got {:?}", result3.status),
            }
        }
    }

    #[test]
    fn test_deduplication_interleaved_duplicates() {
        // Test duplicates mixed with new chunks
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Generate 3 different chunks
        let chunk1 = encoder.generate_chunk().unwrap();
        let chunk2 = encoder.generate_chunk().unwrap();
        let chunk3 = encoder.generate_chunk().unwrap();

        let binary1 = crate::parser::serialize_chunk_to_binary(&chunk1, false);
        let binary2 = crate::parser::serialize_chunk_to_binary(&chunk2, false);
        let binary3 = crate::parser::serialize_chunk_to_binary(&chunk3, false);

        // Process in pattern: 1, 2, 1 (dup), 3, 2 (dup), 1 (dup)
        let patterns = vec![
            (&binary1, false, "chunk1 first time"),
            (&binary2, false, "chunk2 first time"),
            (&binary1, true, "chunk1 duplicate"),
            (&binary3, false, "chunk3 first time"),
            (&binary2, true, "chunk2 duplicate"),
            (&binary1, true, "chunk1 second duplicate"),
        ];

        for (binary_data, should_be_duplicate, desc) in patterns {
            let result = decoder.process_binary_chunk(binary_data, total_source_blocks, "");

            if should_be_duplicate {
                match result.status {
                    crate::types::ChunkStatus::Duplicate => {},
                    _ => panic!("Expected Duplicate for {}, got {:?}", desc, result.status),
                }
            } else {
                match result.status {
                    crate::types::ChunkStatus::Processed => {},
                    _ => panic!("Expected Processed for {}, got {:?}", desc, result.status),
                }
            }
        }

        // Verify received count is 3 (not 6)
        assert_eq!(decoder.get_received_chunk_count(), 3, "Should only count 3 unique chunks");
    }

    #[test]
    fn test_deduplication_chunk_key_consistency() {
        // Test that chunk keys are generated consistently for the same chunk
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

        if let Some(chunk) = encoder.generate_chunk() {
            // Create chunk key
            let chunk_key = crate::parser::create_chunk_key(
                chunk.seed,
                chunk.degree,
                &chunk.indices
            );

            // Check if it's a duplicate (should be false initially)
            assert!(!decoder.is_chunk_duplicate(&chunk_key), "Initial chunk should not be marked as duplicate");

            // Add the chunk key
            decoder.add_chunk_key(chunk_key.clone());

            // Check if it's now a duplicate (should be true)
            assert!(decoder.is_chunk_duplicate(&chunk_key), "Chunk should now be marked as duplicate");

            // Recreate the same chunk key
            let chunk_key2 = crate::parser::create_chunk_key(
                chunk.seed,
                chunk.degree,
                &chunk.indices
            );

            // Should be the same
            assert_eq!(chunk_key, chunk_key2, "Chunk keys should be identical for same chunk");
            assert!(decoder.is_chunk_duplicate(&chunk_key2), "Recreated chunk key should also be duplicate");
        }
    }

    #[test]
    fn test_deduplication_many_chunks() {
        // Test deduplication with many chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Generate 20 chunks
        let mut binaries = Vec::new();
        for _ in 0..20 {
            if let Some(chunk) = encoder.generate_chunk() {
                binaries.push(crate::parser::serialize_chunk_to_binary(&chunk, false));
            }
        }

        // Process all chunks once
        for binary in &binaries {
            decoder.process_binary_chunk(binary, total_source_blocks, "");
        }

        let first_count = decoder.get_received_chunk_count();
        assert_eq!(first_count, 20, "Should have 20 unique chunks");

        // Process all chunks again - all should be duplicates
        for binary in &binaries {
            let result = decoder.process_binary_chunk(binary, total_source_blocks, "");
            match result.status {
                crate::types::ChunkStatus::Duplicate => {},
                _ => panic!("Expected all chunks to be duplicates on second pass"),
            }
        }

        // Count should still be 20
        assert_eq!(decoder.get_received_chunk_count(), 20, "Count should not increase for duplicates");
    }

    #[test]
    fn test_deduplication_with_progress() {
        // Test that duplicates maintain correct progress reporting
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1); // Process immediately

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process once
            let result1 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let progress1 = result1.overall_progress;
            let decoded1 = result1.decoded_block_count;

            // Process duplicate
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Should be duplicate
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {},
                _ => panic!("Expected Duplicate status"),
            }

            // Progress should be the same (duplicates return current progress)
            assert_eq!(result2.overall_progress, progress1, "Progress should not change for duplicate");
            assert_eq!(result2.decoded_block_count, decoded1, "Decoded count should not change for duplicate");
        }
    }

    #[test]
    fn test_deduplication_session_id_same_does_not_clear() {
        // Test that setting the same session ID does NOT clear the cache
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Set session ID
        decoder.set_session_id(100);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process chunk
            let result1 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result1.status {
                crate::types::ChunkStatus::Processed => {},
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Set same session ID again
            decoder.set_session_id(100);

            // Process same chunk again - should still be duplicate (cache not cleared)
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {},
                _ => panic!("Expected Duplicate status after setting same session ID, got {:?}", result2.status),
            }
        }
    }

    #[test]
    fn test_deduplication_does_not_add_to_pending_queue() {
        // Test that duplicates don't get added to the pending chunks queue
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Set high throttle so chunks stay in pending queue
        decoder.set_decode_throttle_count(100);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process first time
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let pending_after_first = decoder.get_pending_chunk_count();
            assert_eq!(pending_after_first, 1, "First chunk should be in pending queue");

            // Process duplicate
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let pending_after_duplicate = decoder.get_pending_chunk_count();
            assert_eq!(pending_after_duplicate, 1, "Duplicate should NOT be added to pending queue");

            // Process duplicate again
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let pending_after_second_dup = decoder.get_pending_chunk_count();
            assert_eq!(pending_after_second_dup, 1, "Second duplicate should NOT be added to pending queue");
        }
    }

    #[test]
    fn test_deduplication_does_not_decode_blocks() {
        // Test that duplicates don't cause any blocks to be decoded
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1); // Process immediately

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process first time and flush
            let result1 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            decoder.flush_pending_chunks();

            let decoded_count_after_first = result1.decoded_block_count;
            let progress_after_first = result1.overall_progress;
            let indices_after_first = result1.decoded_block_indices.clone();

            // Process duplicate
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Verify no additional decoding happened
            assert_eq!(result2.decoded_block_count, decoded_count_after_first,
                "Duplicate should not decode additional blocks");
            assert_eq!(result2.overall_progress, progress_after_first,
                "Duplicate should not change progress");
            assert_eq!(result2.decoded_block_indices, indices_after_first,
                "Duplicate should not change decoded block indices");

            // Process another duplicate
            let result3 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Still no changes
            assert_eq!(result3.decoded_block_count, decoded_count_after_first,
                "Second duplicate should not decode additional blocks");
            assert_eq!(result3.overall_progress, progress_after_first,
                "Second duplicate should not change progress");
        }
    }

    #[test]
    fn test_deduplication_does_not_affect_subsequent_unique_chunks() {
        // Test that after processing duplicates, new unique chunks still work correctly
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);
        decoder.set_decode_throttle_count(1); // Process immediately

        // Generate 3 different chunks
        let chunk1 = encoder.generate_chunk().unwrap();
        let chunk2 = encoder.generate_chunk().unwrap();
        let chunk3 = encoder.generate_chunk().unwrap();

        let binary1 = crate::parser::serialize_chunk_to_binary(&chunk1, false);
        let binary2 = crate::parser::serialize_chunk_to_binary(&chunk2, false);
        let binary3 = crate::parser::serialize_chunk_to_binary(&chunk3, false);

        // Process chunk1
        let result1 = decoder.process_binary_chunk(&binary1, total_source_blocks, "");
        assert!(matches!(result1.status, crate::types::ChunkStatus::Processed));
        let count_after_1 = decoder.get_received_chunk_count();
        assert_eq!(count_after_1, 1);

        // Process chunk1 duplicate
        let result1_dup = decoder.process_binary_chunk(&binary1, total_source_blocks, "");
        assert!(matches!(result1_dup.status, crate::types::ChunkStatus::Duplicate));
        let count_after_1_dup = decoder.get_received_chunk_count();
        assert_eq!(count_after_1_dup, 1, "Duplicate should not increment count");

        // Process chunk2 (unique)
        let result2 = decoder.process_binary_chunk(&binary2, total_source_blocks, "");
        assert!(matches!(result2.status, crate::types::ChunkStatus::Processed));
        let count_after_2 = decoder.get_received_chunk_count();
        assert_eq!(count_after_2, 2, "New chunk should increment count");

        // Process chunk1 duplicate again
        let result1_dup2 = decoder.process_binary_chunk(&binary1, total_source_blocks, "");
        assert!(matches!(result1_dup2.status, crate::types::ChunkStatus::Duplicate));
        let count_after_1_dup2 = decoder.get_received_chunk_count();
        assert_eq!(count_after_1_dup2, 2, "Duplicate should not increment count");

        // Process chunk3 (unique)
        let result3 = decoder.process_binary_chunk(&binary3, total_source_blocks, "");
        assert!(matches!(result3.status, crate::types::ChunkStatus::Processed));
        let count_after_3 = decoder.get_received_chunk_count();
        assert_eq!(count_after_3, 3, "New chunk should increment count");

        // Process chunk2 duplicate
        let result2_dup = decoder.process_binary_chunk(&binary2, total_source_blocks, "");
        assert!(matches!(result2_dup.status, crate::types::ChunkStatus::Duplicate));
        let final_count = decoder.get_received_chunk_count();
        assert_eq!(final_count, 3, "Final count should be 3 unique chunks");
    }

    #[test]
    fn test_deduplication_zero_blocks_decoded_in_result() {
        // Test that duplicate result reports zero blocks decoded
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
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process first time
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Process duplicate - check internal result
            let chunk_dup = crate::parser::parse_binary_chunk(&binary_data, false, total_source_blocks).unwrap();
            let chunk_key = crate::parser::create_chunk_key(
                chunk_dup.chunk.seed,
                chunk_dup.chunk.degree,
                &chunk_dup.chunk.indices
            );

            let process_result = decoder.process_chunk_with_validation(chunk_dup.chunk, chunk_key);

            // Should be duplicate with zero blocks decoded
            assert!(process_result.is_duplicate, "Should be marked as duplicate");
            assert_eq!(process_result.blocks_decoded, 0, "Duplicate should decode zero blocks");
            assert!(process_result.part_complete_info.is_none(), "Duplicate should have no part completion info");
        }
    }

    // ========================================
    // Adaptive Decoding Strategy Tests
    // ========================================

    #[test]
    fn test_adaptive_small_file_less_than_10_chunks() {
        // Test that files requiring less than 10 chunks still decode successfully
        // This verifies the "max(2%, 10)" logic works when total chunks < 10
        let data = vec![1, 2, 3, 4]; // Very small file: 4 bytes
        let options = FountainEncoderOptions::default().with_block_size(2); // 2 blocks total

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // With adaptive strategy:
        // - First decode needs: ceil(2 * 1.10) = 3 chunks
        // - After that: max(ceil(2 * 0.02), 10) = max(1, 10) = 10 chunks
        // But we should still be able to complete with very few chunks via flush

        let mut chunks_added = 0;
        let mut completed = false;

        // Add chunks until we have enough
        while chunks_added < 50 && !completed {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));

                decoder.process_chunk_with_validation(chunk, chunk_key);
                chunks_added += 1;

                // After enough chunks, flush to complete decoding
                if chunks_added >= 5 {
                    decoder.flush_pending_chunks();
                    if decoder.is_complete() {
                        completed = true;
                        break;
                    }
                }
            }
        }

        assert!(completed, "Should complete decoding even with small file");
        assert!(chunks_added < 15, "Should complete with reasonable number of chunks (got {})", chunks_added);

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data, "Decoded data should match original");
    }

    #[test]
    fn test_adaptive_110_percent_threshold_first_decode() {
        // Test that first decode waits for 110% of required chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 10 bytes
        let options = FountainEncoderOptions::default().with_block_size(2); // 5 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 5, "Should have 5 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // 110% of 5 blocks = ceil(5.5) = 6 chunks required for first decode
        let required_for_first_decode = (5.0_f64 * 1.10).ceil() as usize;
        assert_eq!(required_for_first_decode, 6, "Should require 6 chunks for first decode");

        // Add exactly required_for_first_decode - 1 chunks
        for _ in 0..(required_for_first_decode - 1) {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Should have pending chunks (not processed yet)
        let pending_before = decoder.get_pending_chunk_count();
        assert!(pending_before > 0, "Should have pending chunks before threshold");

        // Add one more chunk to reach threshold
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}",
                chunk.seed, chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have processed chunks (pending should be 0 or very low)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(pending_after < pending_before,
            "Should have processed chunks at 110% threshold (pending: {} -> {})",
            pending_before, pending_after);
    }

    #[test]
    fn test_adaptive_incremental_threshold_after_first_decode() {
        // Test that after first decode, threshold is max(2%, 10 chunks)
        let data = vec![0u8; 1000]; // Large file to ensure 2% > 10
        let options = FountainEncoderOptions::default().with_block_size(20); // 50 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 50, "Should have 50 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // First decode: 110% of 50 = 55 chunks
        // After first decode: max(ceil(50 * 0.02), 10) = max(1, 10) = 10 chunks

        // Add chunks to trigger first decode
        let first_decode_threshold = (50.0_f64 * 1.10).ceil() as usize;
        for _ in 0..first_decode_threshold {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // First decode should have been triggered
        assert_eq!(decoder.get_pending_chunk_count(), 0, "First decode should have processed all pending");

        // Now test incremental threshold (should be 10 chunks since 2% of 50 = 1 < 10)
        for i in 1..=9 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
            // Should still have pending chunks (threshold is 10)
            assert_eq!(decoder.get_pending_chunk_count(), i,
                "Should have {} pending chunks before incremental threshold", i);
        }

        // Add 10th chunk - should trigger decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}",
                chunk.seed, chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have processed at 10 chunk threshold
        assert_eq!(decoder.get_pending_chunk_count(), 0,
            "Should have processed chunks at incremental threshold of 10");
    }

    #[test]
    fn test_adaptive_complete_single_part_file_decode() {
        // Test complete decode flow for a single-part file with adaptive strategy
        let data = vec![0u8; 200]; // 200 bytes
        let options = FountainEncoderOptions::default().with_block_size(10); // 20 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 20, "Should have 20 blocks");

        let expected_checksum = crate::checksum::crc32_to_hex(&crate::checksum::crc32(&data));
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_added = 0;
        let mut completed = false;

        // Keep adding chunks until complete
        while chunks_added < 200 && !completed {
            if let Some(chunk) = encoder.generate_chunk() {
                let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

                let result = decoder.process_binary_chunk(
                    &binary_data,
                    total_source_blocks,
                    &expected_checksum,
                );

                chunks_added += 1;

                if result.is_complete {
                    completed = true;
                    assert!(result.completion_data.is_some(), "Should have completion data");

                    let completion_data = result.completion_data.unwrap();
                    assert_eq!(completion_data.data.len(), 200, "Decoded data should be 200 bytes");
                    assert!(completion_data.integrity_ok, "Checksum should be valid");
                    assert_eq!(completion_data.expected_checksum, expected_checksum);
                    assert_eq!(completion_data.actual_checksum, expected_checksum);
                    break;
                }
            }
        }

        assert!(completed, "Should complete decoding");
        assert!(chunks_added >= 22, "Should need at least 110% of blocks (22 chunks)");
        assert!(chunks_added < 100, "Should complete reasonably fast (got {} chunks)", chunks_added);

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data, "Decoded data should match original");
    }

    #[test]
    fn test_adaptive_multi_part_first_decode_110_percent() {
        // Test that 110% threshold applies to each part separately in multi-part mode
        let data = vec![0u8; 200]; // 200 bytes
        let options = FountainEncoderOptions::default().with_block_size(10); // 20 blocks total
        let part_size = 100; // 2 parts of 100 bytes each (10 blocks per part)

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true, // part_based_mode
            part_size,
            None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);

        // Part 0: Should have 10 blocks, need 110% = ceil(11) = 11 chunks for first decode
        let part0_blocks = decoder.get_current_part_total_block_count();
        assert_eq!(part0_blocks, 10, "Part 0 should have 10 blocks");

        let part0_threshold = (part0_blocks as f64 * 1.10).ceil() as usize;
        assert_eq!(part0_threshold, 11, "Part 0 should need 11 chunks for first decode");

        // Add 10 chunks - should stay pending
        for _ in 0..10 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        let pending_before = decoder.get_pending_chunk_count();
        assert!(pending_before > 0, "Should have pending chunks before 110% threshold for part 0");

        // Add 11th chunk - should trigger first decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}",
                chunk.seed, chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        let pending_after = decoder.get_pending_chunk_count();
        assert!(pending_after < pending_before,
            "Should have processed chunks at 110% threshold for part 0");

        // Verify the adaptive strategy is working per-part
        // The key point is that each part gets its own 110% threshold, not the global block count
    }

    #[test]
    fn test_adaptive_percentage_based_threshold_for_large_file() {
        // Test that for very large files, the 2% threshold is used (not 10 chunks)
        // Create a file with 1000 blocks, so 2% = 20 chunks > 10 chunks
        let data = vec![0u8; 10000]; // 10000 bytes
        let options = FountainEncoderOptions::default().with_block_size(10); // 1000 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 1000, "Should have 1000 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // First decode: 110% of 1000 = 1100 chunks
        let first_decode_threshold = (1000.0_f64 * 1.10).ceil() as usize;
        assert_eq!(first_decode_threshold, 1100);

        // Add chunks to trigger first decode
        for _ in 0..first_decode_threshold {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // First decode should have been triggered
        assert_eq!(decoder.get_pending_chunk_count(), 0, "First decode should have processed all pending");

        // Now test incremental threshold
        // For 1000 blocks: max(ceil(1000 * 0.02), 10) = max(20, 10) = 20 chunks
        let incremental_threshold = ((1000.0_f64 * 0.02).ceil() as usize).max(10);
        assert_eq!(incremental_threshold, 20, "Incremental threshold should be 20 (2% of 1000)");

        // Add 19 chunks - should stay pending
        for _ in 0..19 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        assert_eq!(decoder.get_pending_chunk_count(), 19, "Should have 19 pending chunks");

        // Add 20th chunk - should trigger decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}",
                chunk.seed, chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        assert_eq!(decoder.get_pending_chunk_count(), 0,
            "Should have processed at 2% threshold (20 chunks)");
    }

    #[test]
    fn test_adaptive_part_reset_on_transition() {
        // Test that first_decode_attempted flag resets when moving to next part
        let data = vec![0u8; 200]; // 200 bytes
        let options = FountainEncoderOptions::default().with_block_size(10); // 20 blocks
        let part_size = 100; // 2 parts

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true, // part_based_mode
            part_size,
            None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);

        // Set up checksums
        encoder.set_part_checksums(vec![]);
        let part_checksums = encoder.get_part_checksums();
        for (idx, checksum_hex) in part_checksums.iter().enumerate() {
            let mut checksum_array = [0u8; 4];
            for (i, chunk) in checksum_hex.as_bytes().chunks(2).take(4).enumerate() {
                let byte_str = std::str::from_utf8(chunk).unwrap();
                checksum_array[i] = u8::from_str_radix(byte_str, 16).unwrap();
            }
            decoder.set_expected_part_checksum(idx, checksum_array);
        }

        // Part 0: First decode needs 110% of blocks
        let part0_blocks = decoder.get_current_part_total_block_count();
        let part0_threshold = (part0_blocks as f64 * 1.10).ceil() as usize;

        // Add chunks for part 0
        for _ in 0..part0_threshold {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Complete part 0
        while !decoder.is_current_part_complete() {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Move to part 1
        decoder.move_to_next_part();

        // Part 1: Should also need 110% for FIRST decode (flag should have reset)
        let part1_blocks = decoder.get_current_part_total_block_count();
        let part1_threshold = (part1_blocks as f64 * 1.10).ceil() as usize;

        // Add part1_threshold - 1 chunks - should stay pending
        for _ in 0..(part1_threshold - 1) {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!("{}:{}:{}:{}",
                    chunk.seed, chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0));
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        let pending_before = decoder.get_pending_chunk_count();
        assert!(pending_before > 0, "Part 1 should have pending chunks before 110% threshold");

        // Add one more to reach 110%
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!("{}:{}:{}:{}",
                chunk.seed, chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0));
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        let pending_after = decoder.get_pending_chunk_count();
        assert!(pending_after < pending_before,
            "Part 1 should process at 110% threshold, confirming flag reset");
    }
}
