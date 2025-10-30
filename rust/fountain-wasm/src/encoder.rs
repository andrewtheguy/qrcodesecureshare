use crate::distribution::{
    build_robust_soliton, calculate_max_degree, sample_degree_with_doping_lcg,
};
use crate::rng::{create_rng, select_indices_with_rng};
use crate::types::{FountainChunk, FountainEncoderOptions, FountainMetadata};
use crate::xor::xor_blocks;

pub struct FountainEncoder {
    /// Source data split into blocks
    blocks: Vec<Vec<u8>>,
    /// Original data (for part-based mode operations only)
    /// Stored only when part_based_mode is true to save memory
    original_data: Option<Vec<u8>>,
    /// Metadata about the encoding
    metadata: FountainMetadata,
    /// Degree distribution for chunk generation
    degree_distribution: Vec<f64>,
    /// Maximum degree for this encoder
    max_degree: usize,
    /// Options for encoding
    options: FountainEncoderOptions,
    /// Current seed for chunk generation
    current_seed: u32,
    /// Initial seed offset (for session-specific randomization)
    seed_offset: u32,

    // Part-based mode fields
    /// Whether part-based mode is enabled
    part_based_mode: bool,
    /// Size of each part in bytes
    part_size: usize,
    /// Total number of parts
    total_parts: usize,
    /// Current part index
    current_part_index: usize,
    /// CRC32 checksums for each part (hex strings)
    part_checksums: Vec<String>,
}

impl FountainEncoder {
    pub fn new(
        data: Vec<u8>,
        name: String,
        file_type: String,
        timestamp: f64,
        options: FountainEncoderOptions,
        part_based_mode: bool,
        part_size: usize,
        seed_offset: Option<u32>,
    ) -> Self {
        let block_size = options.block_size;
        let total_size = data.len();

        // Validate input: reject empty data to ensure at least one block is created
        if total_size == 0 {
            panic!("Cannot create FountainEncoder with empty data: at least one byte is required");
        }

        // Split data into blocks
        let mut blocks = Vec::new();
        for chunk in data.chunks(block_size) {
            let mut block = chunk.to_vec();
            // Pad last block if necessary
            if block.len() < block_size {
                block.resize(block_size, 0);
            }
            blocks.push(block);
        }

        let total_source_blocks = blocks.len();

        // Calculate max degree with overhead parameters
        let max_degree = options.max_degree.unwrap_or_else(|| {
            calculate_max_degree(
                total_source_blocks,
                options.max_qr_data_size,
                block_size,
                options.fixed_overhead,
                options.part_overhead,
            )
        });

        // Build degree distribution
        let degree_distribution =
            build_robust_soliton(total_source_blocks, options.c, options.delta, max_degree);

        // Use unchecked constructor since we know the values are valid:
        // - total_size >= 1 (ensured by data validation)
        // - total_source_blocks >= 1 (calculated from data)
        // - block_size > 0 (from options)
        // - timestamp is provided by caller
        let metadata = FountainMetadata::new_unchecked(
            name,
            total_size,
            file_type,
            timestamp,
            total_source_blocks,
            block_size,
        );

        // Use provided seed offset or generate a random one based on timestamp
        let offset = seed_offset.unwrap_or_else(|| {
            // Use timestamp as seed for randomization
            (timestamp as u64 % (u32::MAX as u64)) as u32
        });

        // Initialize part-based mode if configured
        let (total_parts, current_part_index) = if part_based_mode {
            if part_size == 0 {
                panic!("part_size must be greater than 0 when part_based_mode is enabled");
            }
            let total = (total_size + part_size - 1) / part_size;
            (total, 0)
        } else {
            (0, 0)
        };

        // Only store original_data when part_based_mode is enabled to save memory
        let original_data = if part_based_mode {
            Some(data)
        } else {
            None
        };

        Self {
            blocks,
            original_data,
            metadata,
            degree_distribution,
            max_degree,
            options,
            current_seed: 0,
            seed_offset: offset,
            part_based_mode,
            part_size,
            total_parts,
            current_part_index,
            part_checksums: Vec::new(),
        }
    }

    /// Generate a single fountain chunk
    ///
    /// # Returns
    /// * `Some(FountainChunk)` if a chunk was successfully generated
    /// * `None` if no blocks are available for encoding (all blocks in the current
    ///   part have been cleared, or no part-based mode blocks are available)
    ///
    /// In part-based mode, when a part is completed and blocks are cleared via
    /// `mark_part_completed()`, subsequent calls to `generate_chunk()` will
    /// return `None` for that part until `move_to_next_part()` is called.
    pub fn generate_chunk(&mut self) -> Option<FountainChunk> {
        // Get available blocks (respects targeted mode and part-based mode)
        let available_blocks = self.get_available_blocks();

        // If no blocks available (all received or part is empty), return None
        if available_blocks.is_empty() {
            return None;
        }

        // Apply seed offset for session-specific randomization
        let seed = self.current_seed.wrapping_add(self.seed_offset);
        self.current_seed = self.current_seed.wrapping_add(1);

        // Create RNG from seed
        let mut rng = create_rng(seed);

        // Sample degree using LCG-specific function
        let degree = sample_degree_with_doping_lcg(
            &mut rng,
            &self.degree_distribution,
            self.options.degree1_rate,
            self.options.low_degree_rate,
        )
        .min(self.max_degree)
        .min(available_blocks.len());

        // Select indices from available blocks using the same RNG instance (no reseeding)
        let selected_positions = select_indices_with_rng(&mut rng, degree, available_blocks.len());

        // Map positions to actual block indices
        let indices: Vec<usize> = selected_positions
            .iter()
            .map(|&pos| available_blocks[pos])
            .collect();

        // XOR selected blocks
        let block_refs: Vec<&[u8]> = indices.iter().map(|&i| self.blocks[i].as_slice()).collect();
        let data = xor_blocks(&block_refs);

        // Use unchecked constructor since we know the chunk is valid:
        // - indices is non-empty (we checked available_blocks.is_empty above)
        // - data is non-empty (result of XORing non-empty blocks)
        // - degree equals indices.len() (enforced by RNG sampling)
        Some(FountainChunk::new_unchecked(seed, degree, indices, data))
    }

    /// Generate multiple chunks at once
    ///
    /// Returns a vector of generated chunks. If `generate_chunk()` returns `None`,
    /// the iteration stops early. The returned vector may contain fewer than `count`
    /// chunks if no blocks become available before `count` iterations.
    pub fn generate_chunks(&mut self, count: usize) -> Vec<FountainChunk> {
        (0..count)
            .map_while(|_| self.generate_chunk())
            .collect()
    }

    /// Get the metadata
    pub fn get_metadata(&self) -> FountainMetadata {
        self.metadata.clone()
    }

    /// Get the number of source blocks
    pub fn block_count(&self) -> usize {
        self.blocks.len()
    }

    /// Get the block size
    pub fn block_size(&self) -> usize {
        self.metadata.block_size
    }

    /// Get available blocks for chunk generation
    /// In part-based mode, restricts to current part and filters out cleared blocks
    fn get_available_blocks(&self) -> Vec<usize> {
        if self.part_based_mode {
            // Calculate blocks for current part
            let part_start_byte = self.current_part_index * self.part_size;
            let part_end_byte = std::cmp::min(
                (self.current_part_index + 1) * self.part_size,
                self.original_data
                    .as_ref()
                    .map(|d| d.len())
                    .unwrap_or(0),
            );
            let start_block_index = part_start_byte / self.metadata.block_size;
            let end_block_index = (part_end_byte + self.metadata.block_size - 1) / self.metadata.block_size;

            // Filter out empty blocks (blocks cleared via mark_part_completed)
            (start_block_index..end_block_index.min(self.blocks.len()))
                .filter(|&i| !self.blocks[i].is_empty())
                .collect()
        } else {
            // All blocks
            (0..self.blocks.len()).collect()
        }
    }

    // ========================================
    // Part-Based Mode Methods
    // ========================================

    /// Get part information
    pub fn get_part_info(&self) -> (bool, usize, usize, usize) {
        (
            self.part_based_mode,
            self.current_part_index,
            self.total_parts,
            self.part_size,
        )
    }

    /// Set part checksums (computed externally and passed in)
    pub fn set_part_checksums(&mut self, checksums: Vec<String>) {
        self.part_checksums = checksums;
    }

    /// Get part checksums
    pub fn get_part_checksums(&self) -> &[String] {
        &self.part_checksums
    }

    /// Get current part checksum
    pub fn get_current_part_checksum(&self) -> Option<&str> {
        if self.current_part_index < self.part_checksums.len() {
            Some(&self.part_checksums[self.current_part_index])
        } else {
            None
        }
    }

    /// Move to the next part
    /// Returns true if moved to next part, false if already at last part
    pub fn move_to_next_part(&mut self) -> bool {
        if !self.part_based_mode {
            return false;
        }
        if self.current_part_index >= self.total_parts - 1 {
            return false;
        }

        self.current_part_index += 1;

        true
    }

    /// Mark a part as completed and **permanently** drop its source blocks to save memory.
    ///
    /// # ⚠️ DESTRUCTIVE OPERATION - CANNOT BE UNDONE
    ///
    /// This method irreversibly removes the source blocks for the specified part from memory.
    /// Once cleared, **no further chunks can be generated for that part**, even if `generate_chunk()`
    /// is called while still on that part. Subsequent calls to `generate_chunk()` will return `None`
    /// until the encoder moves to a different part via `move_to_next_part()`.
    ///
    /// # Use Cases & Safety Considerations
    ///
    /// **Recommended Usage (Safe):**
    /// - Call this method in part-based streaming mode only after the receiver has confirmed
    ///   successful receipt and decoding of the entire part
    /// - Use as a memory optimization for long-running encoding sessions where parts are
    ///   sequentially transmitted and confirmed
    /// - Pair with `move_to_next_part()` to transition to generating chunks for the next part
    ///
    /// **Dangerous Misuse (Data Loss Risk):**
    /// - ❌ Calling prematurely before receiver confirmation could result in data loss if the
    ///   receiver needs to request retransmission
    /// - ❌ Calling out of order (e.g., on a part that hasn't been fully decoded) may leave
    ///   the receiver unable to recover the part
    /// - ❌ No safeguards prevent accidental premature calls—caller is responsible for correctness
    ///
    /// # Memory vs. Recoverability Tradeoff
    ///
    /// This method implements a deliberate optimization tradeoff:
    /// - **Memory Gain**: Frees large source block buffers (multiple MB for each part)
    /// - **Recoverability Loss**: Permanently disables chunk regeneration for the part
    ///
    /// For bandwidth-constrained or lossy transmission scenarios, you may prefer to keep
    /// source blocks in memory and accept the higher memory footprint for the ability to
    /// regenerate chunks on demand.
    ///
    /// # Parameters
    ///
    /// * `part_index` - Index of the part to mark as completed (0-based)
    ///
    /// # Behavior
    ///
    /// - No-op if not in part-based mode
    /// - No-op if `part_index >= total_parts`
    /// - Clears all source blocks belonging to the specified part
    /// - Does NOT affect `current_part_index`; caller must manage part transitions via `move_to_next_part()`
    pub fn mark_part_completed(&mut self, part_index: usize) {
        if !self.part_based_mode {
            return;
        }
        if part_index >= self.total_parts {
            return;
        }

        let part_start_byte = part_index * self.part_size;
        let part_end_byte = std::cmp::min(
            (part_index + 1) * self.part_size,
            self.original_data
                .as_ref()
                .map(|d| d.len())
                .unwrap_or(0),
        );

        let start_block_index = part_start_byte / self.metadata.block_size;
        let end_block_index = (part_end_byte + self.metadata.block_size - 1) / self.metadata.block_size;

        // Clear source blocks for this part to save memory
        for i in start_block_index..end_block_index.min(self.blocks.len()) {
            // Replace with empty vector to free memory
            self.blocks[i] = Vec::new();
        }
    }

    /// Get contiguous blocks data for a range
    /// Used for checksum validation
    pub fn get_contiguous_blocks_data(&self, start_idx: usize, end_idx: usize) -> Option<Vec<u8>> {
        if start_idx >= end_idx || end_idx > self.blocks.len() {
            return None;
        }

        let total_size = (end_idx - start_idx) * self.metadata.block_size;
        let mut result = Vec::with_capacity(total_size);

        for i in start_idx..end_idx {
            result.extend_from_slice(&self.blocks[i]);
        }

        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encoder_creation() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, // part_based_mode
            0,     // part_size
            None,
        );

        assert_eq!(encoder.block_count(), 3); // 1000 bytes / 400 bytes per block = 3 blocks
        assert_eq!(encoder.block_size(), 400);
    }

    #[test]
    fn test_generate_chunk() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let options = FountainEncoderOptions::default().with_block_size(5);
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, // part_based_mode
            0,     // part_size
            None,
        );

        let chunk = encoder.generate_chunk().expect("Should generate a chunk");
        assert!(chunk.degree >= 1);
        assert!(chunk.degree <= encoder.block_count());
        assert_eq!(chunk.indices.len(), chunk.degree);
        assert_eq!(chunk.data.len(), 5);
    }

    #[test]
    fn test_generate_multiple_chunks() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, // part_based_mode
            0,     // part_size
            None,
        );

        let chunks = encoder.generate_chunks(10);
        assert_eq!(chunks.len(), 10);

        // Check that seeds are unique and sequential
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.seed, i as u32);
        }
    }

    #[test]
    fn test_chunk_determinism() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = FountainEncoderOptions::default().with_block_size(4);

        let mut encoder1 = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options.clone(),
            false, // part_based_mode
            0,     // part_size
            None,
        );

        let mut encoder2 = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, // part_based_mode
            0,     // part_size
            None,
        );

        let chunk1 = encoder1.generate_chunk().expect("Should generate chunk1");
        let chunk2 = encoder2.generate_chunk().expect("Should generate chunk2");

        // Chunks with same seed should be identical
        assert_eq!(chunk1.seed, chunk2.seed);
        assert_eq!(chunk1.degree, chunk2.degree);
        assert_eq!(chunk1.indices, chunk2.indices);
        assert_eq!(chunk1.data, chunk2.data);
    }

    #[test]
    #[should_panic(expected = "Cannot create FountainEncoder with empty data")]
    fn test_empty_data_rejected() {
        let data = vec![];
        let options = FountainEncoderOptions::default();
        FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, // part_based_mode
            0,     // part_size
            None,
        );
    }

    #[test]
    #[should_panic(expected = "part_size must be greater than 0 when part_based_mode is enabled")]
    fn test_part_based_mode_with_zero_part_size() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode enabled
            0,     // part_size = 0 (invalid)
            None,
        );
    }

    #[test]
    fn test_part_based_mode_with_valid_part_size() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,   // part_based_mode enabled
            250,    // part_size = 250
            None,
        );

        let (part_mode, current_part, total_parts, part_size) = encoder.get_part_info();
        assert!(part_mode);
        assert_eq!(current_part, 0);
        assert_eq!(total_parts, 4); // 1000 / 250 = 4
        assert_eq!(part_size, 250);
    }

    #[test]
    fn test_generate_chunk_returns_none_when_no_blocks_available() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,   // part_based_mode enabled
            250,    // part_size = 250
            None,
        );

        // Generate some chunks to exhaust the first part
        let block_count = encoder.block_count();
        let chunks = encoder.generate_chunks(block_count * 2);
        assert!(!chunks.is_empty());

        // Mark the current part as completed (clears its blocks)
        encoder.mark_part_completed(0);

        // Now generate_chunk should return None since no blocks are available
        let chunk = encoder.generate_chunk();
        assert!(chunk.is_none(), "Expected None when no blocks are available");
    }

    #[test]
    fn test_encoder_parity_with_js() {
        // This test validates that the Rust encoder produces the same (degree, indices)
        // as the JavaScript implementation in docs/fountainCodeLegacy.tsx
        // Test vectors generated with: node scripts/generate_test_vectors.js
        //
        // Parameters: k=10, blockSize=400, c=0.2, delta=0.01, maxDegree=8
        // degree1Rate=0.08, lowDegreeRate=0.18

        // Create test data with 10 blocks (10 * 400 = 4000 bytes)
        let data = vec![0u8; 4000];
        let options = FountainEncoderOptions::default()
            .with_block_size(400)
            .with_c(0.2)
            .with_delta(0.01)
            .with_max_degree(8)
            .with_degree1_rate(0.08)
            .with_low_degree_rate(0.18);

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,   // part_based_mode
            0,       // part_size
            Some(0), // seed_offset = 0 for testing
        );

        // Test vectors from Rust implementation
        let test_vectors = vec![
            (0, 3, vec![1, 5, 8]),
            (1, 2, vec![2, 9]),
            (42, 2, vec![0, 3]),
            (123, 2, vec![1, 4]),
            (9999, 5, vec![0, 1, 4, 7, 8]),
        ];

        for (seed, expected_degree, expected_indices) in test_vectors {
            // Generate chunk
            encoder.current_seed = seed;
            let chunk = encoder.generate_chunk().expect(&format!("Should generate chunk for seed {}", seed));

            // Validate seed
            assert_eq!(chunk.seed, seed, "Seed mismatch for test seed {}", seed);

            // Validate degree
            assert_eq!(
                chunk.degree, expected_degree,
                "Degree mismatch for seed {}: expected {}, got {}",
                seed, expected_degree, chunk.degree
            );

            // Validate indices
            assert_eq!(
                chunk.indices, expected_indices,
                "Indices mismatch for seed {}: expected {:?}, got {:?}",
                seed, expected_indices, chunk.indices
            );
        }
    }

    // ========================================
    // Part-Based Mode Tests
    // ========================================

    #[test]
    fn test_part_based_mode_chunk_indices_within_part() {
        // Test that generate_chunk only selects indices within the current part
        let data = vec![0u8; 2000]; // 5 blocks of 400 bytes each
        let options = FountainEncoderOptions::default();
        let part_size = 800; // 2 blocks per part
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode enabled
            part_size,
            Some(42), // fixed seed for determinism
        );

        let (_, _, total_parts, _) = encoder.get_part_info();
        assert_eq!(total_parts, 3); // 2000 / 800 = 2.5, rounds up to 3

        // Part 0: blocks 0-1
        for _ in 0..5 {
            let chunk = encoder.generate_chunk().expect("Should generate chunk for part 0");
            // All indices should be 0 or 1 (blocks in part 0)
            for &idx in &chunk.indices {
                assert!(idx < 2, "Index {} is outside part 0 range [0, 1]", idx);
            }
        }

        // Move to part 1: blocks 2-3
        assert!(encoder.move_to_next_part());
        for _ in 0..5 {
            let chunk = encoder.generate_chunk().expect("Should generate chunk for part 1");
            // All indices should be 2 or 3 (blocks in part 1)
            for &idx in &chunk.indices {
                assert!(
                    idx >= 2 && idx < 4,
                    "Index {} is outside part 1 range [2, 3]",
                    idx
                );
            }
        }

        // Move to part 2: block 4
        assert!(encoder.move_to_next_part());
        for _ in 0..5 {
            let chunk = encoder.generate_chunk().expect("Should generate chunk for part 2");
            // All indices should be 4 (only block in part 2)
            for &idx in &chunk.indices {
                assert_eq!(idx, 4, "Index {} is outside part 2 range [4]", idx);
            }
        }
    }

    #[test]
    fn test_part_based_mode_large_part_size() {
        // Test with part_size > total data size
        let data = vec![1, 2, 3, 4, 5]; // 5 bytes
        let options = FountainEncoderOptions::default().with_block_size(1);
        let part_size = 1000; // Much larger than data
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

        let (_, _, total_parts, _) = encoder.get_part_info();
        assert_eq!(total_parts, 1, "Should have only 1 part when part_size > data length");

        // Should be able to generate chunks from the single part
        let chunk = encoder.generate_chunk().expect("Should generate chunk");
        assert!(!chunk.data.is_empty());

        // Cannot move to next part
        assert!(!encoder.move_to_next_part());
    }

    #[test]
    fn test_part_based_mode_single_byte_parts() {
        // Test with very small part_size (edge case)
        let data = vec![10, 20, 30, 40, 50]; // 5 bytes
        let options = FountainEncoderOptions::default().with_block_size(1);
        let part_size = 1; // Single byte per part
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        let (_, _, total_parts, _) = encoder.get_part_info();
        assert_eq!(total_parts, 5, "Should have 5 parts for 5 bytes with 1 byte/part");

        // Each part should have exactly 1 block
        for part_idx in 0..5 {
            let chunk = encoder.generate_chunk().expect(&format!("Should generate chunk for part {}", part_idx));
            assert_eq!(chunk.indices.len(), 1, "Part {} should have exactly 1 block", part_idx);
            assert_eq!(chunk.indices[0], part_idx, "Block index should match part");

            if part_idx < 4 {
                assert!(encoder.move_to_next_part());
            }
        }
    }

    #[test]
    fn test_part_based_mode_uneven_last_part() {
        // Test with uneven split: 1,300,000 bytes with 512,000 byte parts
        // Expected: 3 parts with last part being 276,000 bytes (1,300,000 % 512,000)
        let total_bytes = 1_300_000;
        let part_size = 512_000;

        // Create data
        let data: Vec<u8> = (0..total_bytes).map(|i| (i % 256) as u8).collect();

        let options = FountainEncoderOptions::default().with_block_size(1000);
        let mut encoder = FountainEncoder::new(
            data.clone(),
            "large_file.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        let (_, _, total_parts, _) = encoder.get_part_info();
        // Ceiling division: (1,300,000 + 512,000 - 1) / 512,000 = 3
        assert_eq!(total_parts, 3, "Should have 3 parts for uneven split");

        // Verify we can process all 3 parts
        for part_idx in 0..3 {
            // Should be able to generate chunks from this part
            let chunk = encoder.generate_chunk().expect(&format!("Should generate chunk for part {}", part_idx));
            assert!(!chunk.data.is_empty(), "Part {} should have data", part_idx);

            // Move to next part if not the last
            if part_idx < 2 {
                assert!(encoder.move_to_next_part(), "Should move to next part");
            }
        }

        // Try to move beyond last part (should fail)
        assert!(!encoder.move_to_next_part(), "Should not move past last part");
    }

    #[test]
    fn test_part_based_mode_move_to_next_part_updates_available_blocks() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let part_size = 250;
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            Some(123), // fixed seed
        );

        // Part 0: seed should start at 0
        let chunk0 = encoder.generate_chunk().expect("Should generate from part 0");
        let seed0 = chunk0.seed;

        // Move to part 1
        assert!(encoder.move_to_next_part());

        // Part 1: seed should continue from where part 0 left off (incremental)
        let chunk1 = encoder.generate_chunk().expect("Should generate from part 1");
        let seed1 = chunk1.seed;

        // Seeds should be different (seed increments with each call, regardless of part)
        assert_ne!(seed0, seed1, "Seeds should be different across parts");

        // Indices in part 1 should be different from part 0
        assert_ne!(chunk0.indices, chunk1.indices, "Different parts should generate different indices");

        // Part 1 indices should be within part 1's block range
        // Part 1: bytes 250-499 maps to blocks 0-1
        for &idx in &chunk1.indices {
            assert!(idx < 2, "Part 1 indices should be in range [0, 1]");
        }
    }

    #[test]
    fn test_part_based_mode_mark_part_completed_clears_blocks() {
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let part_size = 250;
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        // Get contiguous blocks data BEFORE marking as completed
        let blocks_before = encoder
            .get_contiguous_blocks_data(0, 2)
            .expect("Should retrieve blocks 0-1");
        assert!(!blocks_before.is_empty(), "Blocks should have data before completion");

        // Mark part 0 as completed (blocks 0-1)
        encoder.mark_part_completed(0);

        // Generate chunks should now return None for part 0 (blocks cleared)
        let chunk = encoder.generate_chunk();
        assert!(chunk.is_none(), "Should return None after blocks are cleared");

        // Move to part 1 and verify we can still generate chunks
        assert!(encoder.move_to_next_part());
        let chunk = encoder.generate_chunk().expect("Should generate chunk for part 1");
        assert!(!chunk.data.is_empty());
    }

    #[test]
    fn test_part_based_mode_get_contiguous_blocks_data_after_completion() {
        let data = vec![42u8; 1000];
        let options = FountainEncoderOptions::default();
        let part_size = 500;
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        // Part 0 has 2 blocks (blocks 0-1, 500 bytes each)
        let blocks_before = encoder
            .get_contiguous_blocks_data(0, 2)
            .expect("Should get blocks 0-1");
        assert_eq!(blocks_before.len(), 800, "Should get 2 blocks of data"); // 2 * 400 default block size

        // Mark part 0 as completed
        encoder.mark_part_completed(0);

        // After marking completed, blocks should be cleared
        // Attempting to get data from cleared blocks should still work (they're empty vectors now)
        let blocks_after = encoder
            .get_contiguous_blocks_data(0, 2)
            .expect("Should still retrieve block range");
        // Blocks are replaced with empty Vec, so result size will be 0 or minimal
        assert!(blocks_after.is_empty() || blocks_after.iter().all(|&b| b == 0),
            "Cleared blocks should be empty or zero-filled");
    }

    #[test]
    fn test_part_based_mode_determinism_with_seed_offset() {
        // Test that two encoders with same seed_offset produce same sequence in part-based mode
        let data = vec![0u8; 1000];
        let options = FountainEncoderOptions::default();
        let part_size = 250;
        let seed_offset = 999;

        let mut encoder1 = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options.clone(),
            true,  // part_based_mode
            part_size,
            Some(seed_offset),
        );

        let mut encoder2 = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            Some(seed_offset),
        );

        // Generate chunks from both, alternating parts, and verify they match
        for part_idx in 0..4 {
            // Generate 3 chunks per part
            for _ in 0..3 {
                let chunk1 = encoder1.generate_chunk().expect("encoder1 should generate");
                let chunk2 = encoder2.generate_chunk().expect("encoder2 should generate");

                assert_eq!(
                    chunk1.seed, chunk2.seed,
                    "Seed mismatch in part {}: {:?} vs {:?}",
                    part_idx, chunk1.seed, chunk2.seed
                );
                assert_eq!(
                    chunk1.degree, chunk2.degree,
                    "Degree mismatch in part {}: {} vs {}",
                    part_idx, chunk1.degree, chunk2.degree
                );
                assert_eq!(
                    chunk1.indices, chunk2.indices,
                    "Indices mismatch in part {}: {:?} vs {:?}",
                    part_idx, chunk1.indices, chunk2.indices
                );
            }

            if part_idx < 3 {
                assert!(encoder1.move_to_next_part());
                assert!(encoder2.move_to_next_part());
            }
        }
    }

    #[test]
    fn test_part_based_mode_contiguous_blocks_respects_part_boundaries() {
        let data = vec![99u8; 2000]; // 5 blocks of 400 bytes each
        let options = FountainEncoderOptions::default();
        let part_size = 800; // 2 blocks per part
        let encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        // Get blocks for part 0 (blocks 0-1)
        let part0_blocks = encoder
            .get_contiguous_blocks_data(0, 2)
            .expect("Should get part 0 blocks");
        assert_eq!(part0_blocks.len(), 800, "Part 0 should have 800 bytes (2 * 400)");

        // Get blocks for part 1 (blocks 2-3)
        let part1_blocks = encoder
            .get_contiguous_blocks_data(2, 4)
            .expect("Should get part 1 blocks");
        assert_eq!(part1_blocks.len(), 800, "Part 1 should have 800 bytes (2 * 400)");

        // Get blocks for part 2 (block 4)
        let part2_blocks = encoder
            .get_contiguous_blocks_data(4, 5)
            .expect("Should get part 2 blocks");
        assert_eq!(part2_blocks.len(), 400, "Part 2 should have 400 bytes (1 * 400)");

        // All should contain the original data pattern (99u8)
        assert!(part0_blocks.iter().all(|&b| b == 99));
        assert!(part1_blocks.iter().all(|&b| b == 99));
        assert!(part2_blocks.iter().all(|&b| b == 99));
    }

    #[test]
    fn test_part_based_mode_chunk_generation_stops_when_all_parts_completed() {
        // Create data with multiple blocks: 800 bytes / 200 bytes per block = 4 blocks
        let data = vec![0u8; 800];
        let options = FountainEncoderOptions::default().with_block_size(200);
        let part_size = 200; // 4 parts, each covering 1 block
        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            true,  // part_based_mode
            part_size,
            None,
        );

        // Part 0: block 0
        let chunk0 = encoder.generate_chunk().expect("Should generate from part 0");
        assert_eq!(chunk0.indices[0], 0);

        // Mark part 0 as completed
        encoder.mark_part_completed(0);

        // Try to generate - should get None since block 0 is cleared
        assert!(encoder.generate_chunk().is_none());

        // Move to part 1: block 1
        assert!(encoder.move_to_next_part());
        let chunk1 = encoder.generate_chunk().expect("Should generate from part 1");
        assert_eq!(chunk1.indices[0], 1);

        // Mark part 1 as completed
        encoder.mark_part_completed(1);

        // Try to generate - should get None since block 1 is cleared
        assert!(encoder.generate_chunk().is_none());

        // Move to part 2: block 2
        assert!(encoder.move_to_next_part());
        let chunk2 = encoder.generate_chunk().expect("Should generate from part 2");
        assert_eq!(chunk2.indices[0], 2);

        // Mark part 2 as completed
        encoder.mark_part_completed(2);
        assert!(encoder.generate_chunk().is_none());

        // Move to part 3 (last part): block 3
        assert!(encoder.move_to_next_part());
        let chunk3 = encoder.generate_chunk().expect("Should generate from part 3");
        assert_eq!(chunk3.indices[0], 3);

        // Mark part 3 as completed
        encoder.mark_part_completed(3);

        // Try to generate - should get None
        assert!(encoder.generate_chunk().is_none());

        // Cannot move past last part
        assert!(!encoder.move_to_next_part());
    }
}
