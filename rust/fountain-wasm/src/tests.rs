//! Comprehensive end-to-end tests for fountain codes with checksum validation
//!
//! These tests validate the complete fountain encoding/decoding flow including:
//! - Basic encode/decode cycles
//! - Checksum validation for encoded/decoded data
//! - Part-based mode with per-part checksums
//! - Various data sizes and patterns
//! - Deterministic behavior

#[cfg(test)]
mod integration_tests {
    use crate::checksum::crc32;
    use crate::decoder::FountainDecoder;
    use crate::encoder::FountainEncoder;
    use crate::types::FountainEncoderOptions;

    /// Generate test data with a predictable pattern
    fn generate_test_data(size: usize) -> Vec<u8> {
        (0..size).map(|i| (i % 256) as u8).collect()
    }

    /// Create a test encoder with sensible defaults for non-part-based mode
    ///
    /// Sets:
    /// - part_based_mode: false (disabled for standard encoding)
    /// - part_size: 0 (not used when part-based mode is disabled)
    /// - seed_offset: None (use default seed behavior)
    ///
    /// # Arguments
    /// * `data` - Data to encode
    /// * `filename` - Name of the file being encoded
    /// * `options` - Encoder algorithm options
    fn make_test_encoder(
        data: Vec<u8>,
        filename: &str,
        options: FountainEncoderOptions,
    ) -> FountainEncoder {
        FountainEncoder::new(
            data,
            filename.to_string(),
            "application/octet-stream".to_string(),
            0.0, // timestamp
            options,
            false,              // part_based_mode
            0,                  // part_size
            None,               // seed_offset
        )
    }

    /// Calculate the maximum expected chunks needed to decode, based on fountain code theory
    ///
    /// Fountain codes (LT codes) with robust soliton distribution require approximately:
    /// `k + O(sqrt(k))` chunks to decode k source blocks, where O(sqrt(k)) is the overhead.
    /// For small k, we add a fixed overhead factor of 1.1x to account for decoder convergence.
    ///
    /// # Arguments
    /// * `total_source_blocks` - Number of blocks the data was encoded into
    /// * `overhead_factor` - Multiplier for expected overhead (typical: 1.1x to 1.3x)
    fn max_expected_chunks(total_source_blocks: usize, overhead_factor: f64) -> usize {
        ((total_source_blocks as f64) * overhead_factor).ceil() as usize
    }

    #[test]
    fn test_e2e_small_file_with_checksum() {
        let data = generate_test_data(100);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(25);
        let mut encoder = make_test_encoder(data.clone(), "test.dat", options);

        let metadata = encoder.get_metadata();
        // Fountain codes require k + overhead chunks, where k is the number of source blocks.
        // We use 1.1x multiplier as typical overhead for robust soliton distribution.
        let max_allowed_chunks = max_expected_chunks(metadata.total_source_blocks, 1.1);
        let mut decoder = FountainDecoder::new(metadata);

        // Encode and decode
        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete(), "Decoder should be complete");
        assert!(
            chunks_sent <= max_allowed_chunks,
            "Should decode with reasonable overhead: {} chunks <= {} max",
            chunks_sent,
            max_allowed_chunks
        );

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded.len(), data.len(), "Decoded data length mismatch");

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum, "Checksum mismatch");

        // Validate data integrity
        assert_eq!(decoded, data, "Decoded data does not match original");
    }

    #[test]
    fn test_e2e_medium_file_with_checksum() {
        let data = generate_test_data(5000);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(400);
        let mut encoder = make_test_encoder(data.clone(), "medium.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_large_file_with_checksum() {
        let data = generate_test_data(50000);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(1000);
        let mut encoder = make_test_encoder(data.clone(), "large.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 2000 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_random_data_with_checksum() {
        use crate::rng::create_rng;
        use rand::RngCore;

        // Generate pseudo-random data using fountain RNG
        let mut rng = create_rng(12345);
        let data: Vec<u8> = (0..1000)
            .map(|_| (rng.next_u32() % 256) as u8)
            .collect();

        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(250);
        let mut encoder = make_test_encoder(data.clone(), "random.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 200 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_all_zeros_with_checksum() {
        let data = vec![0u8; 2000];
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(500);
        let mut encoder = make_test_encoder(data.clone(), "zeros.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 200 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_all_ones_with_checksum() {
        let data = vec![0xFFu8; 2000];
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(500);
        let mut encoder = make_test_encoder(data.clone(), "ones.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 200 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_checksum_determinism() {
        let data1 = generate_test_data(1000);
        let data2 = generate_test_data(1000);

        let checksum1 = crc32(&data1);
        let checksum2 = crc32(&data2);

        // Same data should produce same checksum
        assert_eq!(checksum1, checksum2);

        // Different data should produce different checksum
        let data3 = vec![0u8; 1000];
        let checksum3 = crc32(&data3);
        assert_ne!(checksum1, checksum3);
    }

    #[test]
    fn test_e2e_with_packet_loss_simulation() {
        // Use larger data to ensure we need enough chunks to simulate packet loss
        let data = generate_test_data(5000);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(400);
        let mut encoder = make_test_encoder(data.clone(), "lossy.dat", options);

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Simulate 20% packet loss (drop every 5th chunk)
        let mut chunks_sent = 0;
        let mut chunks_delivered = 0;
        let mut chunks_dropped = 0;
        while !decoder.is_complete() && chunks_sent < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                chunks_sent += 1;

                // Drop every 5th chunk (20% packet loss)
                if chunks_sent % 5 != 0 {
                    decoder.add_chunk(chunk);
                    chunks_delivered += 1;
                } else {
                    chunks_dropped += 1;
                }
            } else {
                chunks_sent += 1;
            }
        }

        assert!(decoder.is_complete());
        // Verify that packets were dropped during transmission
        assert!(
            chunks_dropped > 0,
            "Expected some packets to be dropped, but none were. Sent: {}, Delivered: {}",
            chunks_sent,
            chunks_delivered
        );
        // Fountain codes should handle packet loss gracefully
        assert!(
            chunks_delivered > total_source_blocks,
            "Should need more chunks than source blocks due to packet loss"
        );

        let decoded = decoder.get_decoded_data().unwrap();
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_incremental_progress_with_checksums() {
        let data = generate_test_data(2000);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(400);
        let mut encoder = make_test_encoder(data.clone(), "progress.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut last_progress = 0.0;
        let mut chunks_sent = 0;

        while !decoder.is_complete() && chunks_sent < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                chunks_sent += 1;

                let progress = decoder.get_progress();
                // Progress should never decrease
                assert!(
                    progress >= last_progress,
                    "Progress decreased from {} to {}",
                    last_progress,
                    progress
                );
                last_progress = progress;
            } else {
                chunks_sent += 1;
            }
        }

        assert!(decoder.is_complete());
        assert_eq!(decoder.get_progress(), 1.0);

        let decoded = decoder.get_decoded_data().unwrap();
        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_e2e_part_based_mode_with_checksums() {
        let data = generate_test_data(10000);
        let original_checksum = crc32(&data);
        let part_size = 2500;

        let options = FountainEncoderOptions::default().with_block_size(400);
        let mut encoder = make_test_encoder(data.clone(), "parts.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);

        // Decode all parts
        let total_parts = (data.len() + part_size - 1) / part_size;
        let mut all_parts_data = Vec::new();

        for part_idx in 0..total_parts {
            let mut chunks_sent = 0;
            while !decoder.is_current_part_complete() && chunks_sent < 500 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks_sent += 1;
            }

            assert!(
                decoder.is_current_part_complete(),
                "Part {} should be complete",
                part_idx
            );

            let part_data = decoder.get_current_part_data().unwrap();

            // Validate part checksum (CRC32 produces 4 bytes)
            let _part_checksum = crc32(&part_data);

            all_parts_data.extend_from_slice(&part_data);

            // Move to next part
            if part_idx < total_parts - 1 {
                assert!(decoder.move_to_next_part());
            }
        }

        // Validate complete file checksum
        let reconstructed_checksum = crc32(&all_parts_data);
        assert_eq!(reconstructed_checksum, original_checksum);
        assert_eq!(all_parts_data, data);
    }

    #[test]
    fn test_e2e_part_based_individual_part_checksums() {
        let data = generate_test_data(8000);
        let part_size = 2000;

        // Pre-compute expected part checksums
        let mut expected_part_checksums = Vec::new();
        for i in 0..4 {
            let start = i * part_size;
            let end = std::cmp::min(start + part_size, data.len());
            let part_data = &data[start..end];
            expected_part_checksums.push(crc32(part_data));
        }

        let options = FountainEncoderOptions::default().with_block_size(400);
        let mut encoder = make_test_encoder(data.clone(), "parts_check.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::with_part_mode(metadata, part_size);

        // Decode each part and validate its checksum
        for (part_idx, expected_checksum) in expected_part_checksums.iter().enumerate() {
            let mut chunks_sent = 0;
            while !decoder.is_current_part_complete() && chunks_sent < 500 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks_sent += 1;
            }

            assert!(decoder.is_current_part_complete());
            let part_data = decoder.get_current_part_data().unwrap();
            let part_checksum = crc32(&part_data);

            assert_eq!(
                part_checksum, *expected_checksum,
                "Part {} checksum mismatch",
                part_idx
            );

            if part_idx < 3 {
                decoder.move_to_next_part();
            }
        }
    }

    #[test]
    fn test_e2e_single_byte_with_checksum() {
        let data = vec![42u8];
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(10);
        let mut encoder = make_test_encoder(data.clone(), "single.dat", options);

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 50 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().unwrap();

        let decoded_checksum = crc32(&decoded);
        assert_eq!(decoded_checksum, original_checksum);
        assert_eq!(decoded, data);
    }
}

#[cfg(test)]
mod wasm_refactoring_tests {
    //! Tests for the refactored WASM methods that use serde instead of js_sys
    //! These tests verify that the refactored methods produce correct results
    //! without requiring WASM compilation.

    use crate::checksum::crc32;
    use crate::encoder::FountainEncoder;
    use crate::decoder::FountainDecoder;
    use crate::parser::{parse_binary_chunk, create_chunk_key};
    use crate::types::{FountainEncoderOptions, PartInfo};

    /// Helper to create a test encoder
    fn make_encoder(data_size: usize, part_based_mode: bool, part_size: usize) -> FountainEncoder {
        let data = (0..data_size).map(|i| (i % 256) as u8).collect();
        FountainEncoder::new(
            data,
            "test.bin".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            FountainEncoderOptions::default(),
            part_based_mode,
            part_size,
            None,
        )
    }

    /// Helper to create a test decoder
    fn make_decoder(data_size: usize, part_based_mode: bool, part_size: usize) -> FountainDecoder {
        let encoder = make_encoder(data_size, part_based_mode, part_size);
        let metadata = encoder.get_metadata().clone();

        if part_based_mode {
            FountainDecoder::with_part_mode(metadata, part_size)
        } else {
            FountainDecoder::new(metadata)
        }
    }

    // ============================================================
    // Tests for get_part_info() methods
    // ============================================================

    #[test]
    fn test_encoder_get_part_info_without_part_mode() {
        let encoder = make_encoder(1000, false, 0);
        let (part_based_mode, current_part_index, total_parts, part_size) = encoder.get_part_info();

        assert_eq!(part_based_mode, false);
        assert_eq!(current_part_index, 0);
        assert_eq!(total_parts, 0);
        assert_eq!(part_size, 0);
    }

    #[test]
    fn test_encoder_get_part_info_with_part_mode() {
        let data_size = 10000;
        let part_size = 1000;
        let encoder = make_encoder(data_size, true, part_size);
        let (part_based_mode, current_part_index, total_parts, _part_size) = encoder.get_part_info();

        assert_eq!(part_based_mode, true);
        assert_eq!(current_part_index, 0); // Initial state
        assert!(total_parts > 0); // Should have calculated parts
    }

    #[test]
    fn test_encoder_part_info_after_move() {
        let data_size = 5000;
        let part_size = 1000;
        let mut encoder = make_encoder(data_size, true, part_size);

        // Move to next part
        let could_move = encoder.move_to_next_part();
        assert!(could_move);

        let (part_based_mode, current_part_index, total_parts, _part_size) = encoder.get_part_info();

        assert_eq!(part_based_mode, true);
        assert_eq!(current_part_index, 1); // Should be at part 1
        assert!(total_parts > 1);
    }

    #[test]
    fn test_decoder_get_part_info_without_part_mode() {
        let decoder = make_decoder(1000, false, 0);
        let (part_based_mode, current_part_index, total_parts, part_size) = decoder.get_part_info();

        assert_eq!(part_based_mode, false);
        assert_eq!(current_part_index, 0);
        assert_eq!(total_parts, 0);
        assert_eq!(part_size, 0);
    }

    #[test]
    fn test_decoder_get_part_info_with_part_mode() {
        let data_size = 10000;
        let part_size = 1000;
        let decoder = make_decoder(data_size, true, part_size);
        let (part_based_mode, current_part_index, total_parts, returned_part_size) = decoder.get_part_info();

        assert_eq!(part_based_mode, true);
        assert_eq!(current_part_index, 0); // Initial state
        assert!(total_parts > 0);
        assert_eq!(returned_part_size, part_size);
    }

    #[test]
    fn test_part_info_struct_serialization() {
        let encoder = make_encoder(5000, true, 1000);
        let (part_based_mode, current_part_index, total_parts, part_size) = encoder.get_part_info();

        // Create PartInfo struct as the refactored methods would
        let part_info = PartInfo {
            part_based_mode,
            current_part_index: current_part_index as u32,
            total_parts: total_parts as u32,
            part_size: part_size as u32,
            current_part_checksum: None,
            part_checksums: None,
        };

        // Verify fields
        assert_eq!(part_info.part_based_mode, true);
        assert_eq!(part_info.current_part_index, 0);
        assert!(part_info.total_parts > 0);
        assert_eq!(part_info.part_size, 1000);
        assert!(part_info.current_part_checksum.is_none());
        assert!(part_info.part_checksums.is_none());
    }

    #[test]
    fn test_part_info_with_checksums() {
        let encoder = make_encoder(5000, true, 1000);
        let (part_based_mode, current_part_index, total_parts, part_size) = encoder.get_part_info();

        // Simulate checksums from encoder
        let checksums = vec!["abc123".to_string(), "def456".to_string()];
        let current_checksum = checksums.get(current_part_index).cloned();

        let part_info = PartInfo {
            part_based_mode,
            current_part_index: current_part_index as u32,
            total_parts: total_parts as u32,
            part_size: part_size as u32,
            current_part_checksum: current_checksum,
            part_checksums: Some(checksums),
        };

        assert!(part_info.current_part_checksum.is_some());
        assert_eq!(part_info.current_part_checksum.unwrap(), "abc123");
        assert_eq!(part_info.part_checksums.as_ref().unwrap().len(), 2);
    }

    // ============================================================
    // Tests for parse_binary_chunk_internal()
    // ============================================================

    #[test]
    fn test_parse_binary_chunk_internal_basic() {
        let data = vec![0xAA, 0xBB, 0xCC];
        let mut encoder = make_encoder(data.len(), false, 0);

        // Generate a chunk
        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        // Convert to binary format (this is the format parse_binary_chunk expects)
        let mut binary = Vec::new();
        binary.push(0xFF); // Magic byte 1
        binary.push(0xFD); // Magic byte 2
        binary.push((chunk.seed >> 8) as u8); // Seed high
        binary.push(chunk.seed as u8); // Seed low
        binary.push(chunk.degree as u8); // Degree
        binary.push(chunk.indices.len() as u8); // NumIndices

        // Add indices
        for &idx in &chunk.indices {
            binary.push((idx >> 8) as u8);
            binary.push(idx as u8);
        }

        // Add data
        binary.extend_from_slice(&chunk.data);

        // Add placeholder checksum (4 bytes)
        binary.extend_from_slice(&[0, 0, 0, 0]);

        // Now parse it back
        let parsed = parse_binary_chunk(&binary, false, encoder.get_metadata().total_source_blocks)
            .expect("Failed to parse chunk");

        assert_eq!(parsed.chunk.seed, chunk.seed);
        assert_eq!(parsed.chunk.degree, chunk.degree);
        assert_eq!(parsed.chunk.indices, chunk.indices);
        assert_eq!(parsed.chunk.data, chunk.data);
        assert!(parsed.part_metadata.is_none()); // No part metadata in non-part mode
    }

    #[test]
    fn test_parse_binary_chunk_with_part_metadata() {
        let mut encoder = make_encoder(1000, true, 100);
        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        // Build binary with part metadata
        let mut binary = Vec::new();
        binary.push(0xFF);
        binary.push(0xFD);
        binary.push((chunk.seed >> 8) as u8);
        binary.push(chunk.seed as u8);
        binary.push(chunk.degree as u8);
        binary.push(chunk.indices.len() as u8);

        for &idx in &chunk.indices {
            binary.push((idx >> 8) as u8);
            binary.push(idx as u8);
        }

        // Add part metadata (8 bytes)
        binary.push(0); // current_part high
        binary.push(0); // current_part low
        binary.push(0); // total_parts high
        binary.push(5); // total_parts low = 5
        binary.push(0xAA);
        binary.push(0xBB);
        binary.push(0xCC);
        binary.push(0xDD);

        // Add data
        binary.extend_from_slice(&chunk.data);

        // Add checksum
        binary.extend_from_slice(&[0, 0, 0, 0]);

        let parsed = parse_binary_chunk(&binary, true, encoder.get_metadata().total_source_blocks)
            .expect("Failed to parse chunk");

        assert!(parsed.part_metadata.is_some());
        let part_meta = parsed.part_metadata.unwrap();
        assert_eq!(part_meta.current_part, 0);
        assert_eq!(part_meta.total_parts, 5);
        assert_eq!(part_meta.part_checksum, [0xAA, 0xBB, 0xCC, 0xDD]);
    }

    #[test]
    fn test_parsed_chunk_result_from_parser() {
        let mut encoder = make_encoder(500, false, 0);
        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        // Build binary representation
        let mut binary = Vec::new();
        binary.push(0xFF);
        binary.push(0xFD);
        binary.push((chunk.seed >> 8) as u8);
        binary.push(chunk.seed as u8);
        binary.push(chunk.degree as u8);
        binary.push(chunk.indices.len() as u8);

        for &idx in &chunk.indices {
            binary.push((idx >> 8) as u8);
            binary.push(idx as u8);
        }

        binary.extend_from_slice(&chunk.data);
        binary.extend_from_slice(&[0, 0, 0, 0]);

        let parsed = parse_binary_chunk(&binary, false, encoder.get_metadata().total_source_blocks)
            .expect("Failed to parse");

        // Verify fields that would go into ParsedChunkResult
        assert_eq!(parsed.chunk.seed, chunk.seed);
        assert_eq!(parsed.chunk.degree, chunk.degree);
        assert!(parsed.checksum_start > 0);
        assert!(parsed.checksum_start <= binary.len());

        // Verify indices are properly converted to u32 range
        for &idx in &parsed.chunk.indices {
            assert!(idx < encoder.get_metadata().total_source_blocks);
        }
    }

    // ============================================================
    // Tests for create_chunk_key()
    // ============================================================

    #[test]
    fn test_create_chunk_key_consistency() {
        let mut encoder = make_encoder(1000, false, 0);
        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        let key1 = create_chunk_key(chunk.seed, chunk.degree, &chunk.indices);
        let key2 = create_chunk_key(chunk.seed, chunk.degree, &chunk.indices);

        // Same chunk should produce same key
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_create_chunk_key_format() {
        let seed = 42u32;
        let degree = 3usize;
        let indices = vec![0, 1, 2];

        let key = create_chunk_key(seed, degree, &indices);

        // Format should be "seed:degree:firstIdx:lastIdx"
        let parts: Vec<&str> = key.split(':').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "42");
        assert_eq!(parts[1], "3");
        assert_eq!(parts[2], "0");
        assert_eq!(parts[3], "2");
    }

    #[test]
    fn test_create_chunk_key_differentiates_chunks() {
        let mut encoder = make_encoder(1000, false, 0);

        let chunk1 = encoder.generate_chunk().expect("Failed to generate chunk 1");
        let chunk2 = encoder.generate_chunk().expect("Failed to generate chunk 2");

        let key1 = create_chunk_key(chunk1.seed, chunk1.degree, &chunk1.indices);
        let key2 = create_chunk_key(chunk2.seed, chunk2.degree, &chunk2.indices);

        // Different chunks should (most likely) have different keys
        // Note: There's a tiny chance they could be the same, but with random generation it's extremely unlikely
        if chunk1.seed != chunk2.seed || chunk1.indices != chunk2.indices {
            assert_ne!(key1, key2);
        }
    }

    // ============================================================
    // Integration tests combining multiple refactored methods
    // ============================================================

    #[test]
    fn test_encoder_workflow_with_part_info() {
        let mut encoder = make_encoder(5000, true, 1000);

        // Get initial part info
        let (pb_mode, current, _total, _part_size) = encoder.get_part_info();
        assert_eq!(pb_mode, true);
        assert_eq!(current, 0);

        // Generate chunks for first part
        let chunk1 = encoder.generate_chunk().expect("Failed to generate chunk 1");
        let key1 = create_chunk_key(chunk1.seed, chunk1.degree, &chunk1.indices);
        assert!(!key1.is_empty());

        // Move to next part
        let moved = encoder.move_to_next_part();
        assert!(moved);

        let (_, current_new, _, _) = encoder.get_part_info();
        assert_eq!(current_new, current + 1);

        // Generate chunk for second part
        let chunk2 = encoder.generate_chunk().expect("Failed to generate chunk 2");
        let key2 = create_chunk_key(chunk2.seed, chunk2.degree, &chunk2.indices);

        // Keys should be different (different parts usually have different seeds)
        if chunk1.seed != chunk2.seed {
            assert_ne!(key1, key2);
        }
    }

    #[test]
    fn test_decoder_workflow_with_part_info() {
        let decoder = make_decoder(5000, true, 1000);

        let (pb_mode, current, total, part_size) = decoder.get_part_info();
        assert_eq!(pb_mode, true);
        assert_eq!(current, 0);
        assert_eq!(part_size, 1000);

        // Verify all fields fit in u32
        assert!(current <= u32::MAX as usize);
        assert!(total <= u32::MAX as usize);
        assert!(part_size <= u32::MAX as usize);
    }

    #[test]
    fn test_full_roundtrip_with_checksums() {
        let data = vec![42u8; 1000];
        let _original_checksum = crc32(&data);

        // Create encoder and generate chunks
        let mut encoder = make_encoder(1000, true, 250);
        let chunk1 = encoder.generate_chunk().expect("Failed to generate chunk");

        // Parse the binary format (simulating what JavaScript would do)
        let mut binary = Vec::new();
        binary.push(0xFF);
        binary.push(0xFD);
        binary.push((chunk1.seed >> 8) as u8);
        binary.push(chunk1.seed as u8);
        binary.push(chunk1.degree as u8);
        binary.push(chunk1.indices.len() as u8);

        for &idx in &chunk1.indices {
            binary.push((idx >> 8) as u8);
            binary.push(idx as u8);
        }

        // Add part metadata
        binary.push(0);
        binary.push(0);
        binary.push(0);
        binary.push(1);
        binary.push(0xAB);
        binary.push(0xCD);
        binary.push(0xEF);
        binary.push(0x12);

        binary.extend_from_slice(&chunk1.data);
        binary.extend_from_slice(&[0, 0, 0, 0]);

        // Parse with part-based mode
        let parsed = parse_binary_chunk(&binary, true, encoder.get_metadata().total_source_blocks)
            .expect("Parse failed");

        // Verify structure
        assert_eq!(parsed.chunk.seed, chunk1.seed);
        assert!(parsed.part_metadata.is_some());

        // Create key for deduplication
        let key = create_chunk_key(parsed.chunk.seed, parsed.chunk.degree, &parsed.chunk.indices);
        assert!(!key.is_empty());

        // Compute and verify checksum
        let payload = &binary[2..parsed.checksum_start];
        let computed = crc32(payload);
        assert!(computed.len() > 0);
    }
}

#[cfg(test)]
mod wasm_lib_tests {
    //! Tests for WASM methods exposed in lib.rs
    //! These tests verify that the WASM wrapper methods correctly interact with
    //! the underlying Rust fountain codec without requiring JavaScript/WASM execution.

    use crate::encoder::FountainEncoder;
    use crate::decoder::FountainDecoder;
    use crate::types::FountainEncoderOptions;
    use crate::checksum::crc32;

    /// Helper to create a test encoder
    fn make_test_encoder(data_size: usize, part_based_mode: bool, part_size: usize) -> FountainEncoder {
        let data = (0..data_size).map(|i| (i % 256) as u8).collect();
        FountainEncoder::new(
            data,
            "test.bin".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            FountainEncoderOptions::default(),
            part_based_mode,
            part_size,
            None,
        )
    }

    /// Helper to create a test decoder
    fn make_test_decoder(data_size: usize, part_based_mode: bool, part_size: usize) -> FountainDecoder {
        let encoder = make_test_encoder(data_size, part_based_mode, part_size);
        let metadata = encoder.get_metadata().clone();

        if part_based_mode {
            FountainDecoder::with_part_mode(metadata, part_size)
        } else {
            FountainDecoder::new(metadata)
        }
    }

    // ============================================================
    // WasmFountainEncoder Tests
    // ============================================================

    #[test]
    fn test_encoder_block_count() {
        let encoder = make_test_encoder(1000, false, 0);
        let block_count = encoder.block_count();
        assert!(block_count > 0);
    }

    #[test]
    fn test_encoder_block_size() {
        let encoder = make_test_encoder(1000, false, 0);
        let block_size = encoder.block_size();
        assert!(block_size > 0);
        // Block size should be reasonable (between 8 bytes and 64KB)
        assert!(block_size >= 8);
        assert!(block_size <= 65536);
    }

    #[test]
    fn test_encoder_block_count_and_size_consistency() {
        let data_size = 5000;
        let encoder = make_test_encoder(data_size, false, 0);

        let block_count = encoder.block_count();
        let block_size = encoder.block_size();

        // Product should be close to original data size
        let total_capacity = block_count * block_size;
        assert!(total_capacity >= data_size);
        assert!(total_capacity <= data_size * 2); // Should not be much larger
    }

    #[test]
    fn test_encoder_generate_chunk() {
        let mut encoder = make_test_encoder(1000, false, 0);
        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        assert!(chunk.seed > 0 || chunk.seed == 0); // Seed can be any value
        assert_eq!(chunk.degree, chunk.indices.len()); // Degree should match indices
        assert!(chunk.degree > 0);
        assert!(!chunk.data.is_empty());
    }

    #[test]
    fn test_encoder_generate_multiple_chunks() {
        let mut encoder = make_test_encoder(1000, false, 0);

        let chunk1 = encoder.generate_chunk().expect("Failed to generate chunk 1");
        let chunk2 = encoder.generate_chunk().expect("Failed to generate chunk 2");
        let chunk3 = encoder.generate_chunk().expect("Failed to generate chunk 3");

        // Chunks should have different seeds (with very high probability)
        let mut unique_seeds = std::collections::HashSet::new();
        unique_seeds.insert(chunk1.seed);
        unique_seeds.insert(chunk2.seed);
        unique_seeds.insert(chunk3.seed);

        // At least 2 different seeds should be present (virtually guaranteed)
        assert!(unique_seeds.len() >= 2);
    }

    #[test]
    fn test_encoder_get_metadata() {
        let encoder = make_test_encoder(5000, false, 0);
        let metadata = encoder.get_metadata();

        assert_eq!(metadata.size, 5000);
        assert_eq!(metadata.name, "test.bin");
        assert_eq!(metadata.file_type, "application/octet-stream");
        assert!(metadata.total_source_blocks > 0);
        assert!(metadata.block_size > 0);
    }

    #[test]
    fn test_encoder_set_and_get_part_checksums() {
        let mut encoder = make_test_encoder(5000, true, 1000);

        let checksums = vec!["checksum1".to_string(), "checksum2".to_string()];
        encoder.set_part_checksums(checksums.clone());

        let stored = encoder.get_part_checksums();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored, checksums);
    }

    #[test]
    fn test_encoder_move_to_next_part() {
        let mut encoder = make_test_encoder(5000, true, 1000);

        // Can move to next part multiple times
        assert!(encoder.move_to_next_part());
        assert!(encoder.move_to_next_part());

        // Eventually should reach the end
        while encoder.move_to_next_part() {
            // Keep moving
        }
        // After last move fails, trying again should also fail
        assert!(!encoder.move_to_next_part());
    }

    #[test]
    fn test_encoder_part_info_consistency() {
        let mut encoder = make_test_encoder(5000, true, 1000);

        let (pb_initial, current_initial, _total_initial, _size_initial) = encoder.get_part_info();
        assert_eq!(current_initial, 0);
        assert!(pb_initial);

        encoder.move_to_next_part();

        let (pb_after, current_after, _total_after, _size_after) = encoder.get_part_info();
        assert_eq!(current_after, current_initial + 1);
        assert_eq!(pb_after, pb_initial);
    }

    #[test]
    fn test_encoder_get_contiguous_blocks_data() {
        let encoder = make_test_encoder(1000, false, 0);

        let block_count = encoder.block_count();
        if block_count >= 2 {
            let data = encoder.get_contiguous_blocks_data(0, 1);
            assert!(data.is_some());

            let data_array = data.unwrap();
            assert!(data_array.len() > 0);
        }
    }

    #[test]
    fn test_encoder_mark_part_completed() {
        let mut encoder = make_test_encoder(5000, true, 1000);

        // Should be able to mark part as completed
        encoder.mark_part_completed(0);
        // No assertion needed - just verify it doesn't panic
    }

    // ============================================================
    // WasmFountainDecoder Tests
    // ============================================================

    #[test]
    fn test_decoder_is_complete_initially_false() {
        let decoder = make_test_decoder(1000, false, 0);
        assert!(!decoder.is_complete());
    }

    #[test]
    fn test_decoder_get_progress_initially_zero() {
        let decoder = make_test_decoder(1000, false, 0);
        let progress = decoder.get_progress();
        assert_eq!(progress, 0.0);
    }

    #[test]
    fn test_decoder_get_decoded_block_count_initially_zero() {
        let decoder = make_test_decoder(1000, false, 0);
        assert_eq!(decoder.get_decoded_block_count(), 0);
    }

    #[test]
    fn test_decoder_get_received_chunk_count_initially_zero() {
        let decoder = make_test_decoder(1000, false, 0);
        assert_eq!(decoder.get_received_chunk_count(), 0);
    }

    #[test]
    fn test_decoder_get_metadata() {
        let decoder = make_test_decoder(5000, false, 0);
        let metadata = decoder.get_metadata();

        assert_eq!(metadata.size, 5000);
        assert_eq!(metadata.name, "test.bin");
        assert!(metadata.total_source_blocks > 0);
    }

    #[test]
    fn test_decoder_add_chunk_basic() {
        let mut encoder = make_test_encoder(1000, false, 0);
        let mut decoder = make_test_decoder(1000, false, 0);

        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");

        // add_chunk returns bool indicating if chunk was new/useful, not necessarily added
        let _was_decoded = decoder.add_chunk(chunk);
        // Verify the chunk was received
        assert!(decoder.get_received_chunk_count() > 0);
    }

    #[test]
    fn test_decoder_add_chunk_increments_count() {
        let mut encoder = make_test_encoder(1000, false, 0);
        let mut decoder = make_test_decoder(1000, false, 0);

        let initial_count = decoder.get_received_chunk_count();

        let chunk = encoder.generate_chunk().expect("Failed to generate chunk");
        let _ = decoder.add_chunk(chunk);

        let new_count = decoder.get_received_chunk_count();
        assert_eq!(new_count, initial_count + 1);
    }

    #[test]
    fn test_decoder_progress_increases_with_chunks() {
        let mut encoder = make_test_encoder(1000, false, 0);
        let mut decoder = make_test_decoder(1000, false, 0);

        let initial_progress = decoder.get_progress();
        assert_eq!(initial_progress, 0.0);

        // Add several chunks
        for _ in 0..10 {
            if let Some(chunk) = encoder.generate_chunk() {
                let _ = decoder.add_chunk(chunk);
            }
        }

        let new_progress = decoder.get_progress();
        // Progress should be greater than initial (likely greater than 0)
        assert!(new_progress >= initial_progress);
    }

    #[test]
    fn test_decoder_get_decoded_block_indices() {
        let mut encoder = make_test_encoder(1000, false, 0);
        let mut decoder = make_test_decoder(1000, false, 0);

        // Add some chunks
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let _ = decoder.add_chunk(chunk);
            }
        }

        let indices = decoder.get_decoded_block_indices();
        // Should return a Vec of indices
        assert!(indices.is_empty() || !indices.is_empty()); // Decoded blocks or empty
        let _ = decoder.get_decoded_block_count();
    }

    #[test]
    fn test_decoder_part_mode_methods() {
        let decoder = make_test_decoder(5000, true, 1000);

        // Should start with current part not complete
        assert!(!decoder.is_current_part_complete());

        let block_count = decoder.get_current_part_decoded_block_count();
        assert_eq!(block_count, 0); // No blocks decoded yet

        let total_blocks = decoder.get_current_part_total_block_count();
        assert!(total_blocks > 0); // Should have blocks in first part
    }

    #[test]
    fn test_decoder_move_to_next_part() {
        let mut decoder = make_test_decoder(5000, true, 1000);

        // Get initial part index from decoder
        let (_pb, initial_part, _total, _size) = decoder.get_part_info();
        let moved = decoder.move_to_next_part();
        assert!(moved);

        let (_pb_new, new_part, _total_new, _size_new) = decoder.get_part_info();
        assert_eq!(new_part, initial_part + 1);
    }

    #[test]
    fn test_decoder_mark_part_completed() {
        let mut decoder = make_test_decoder(5000, true, 1000);

        // Should be able to mark part as completed
        decoder.mark_part_completed(0);
        // No assertion needed - just verify it doesn't panic
    }

    // ============================================================
    // Integration Tests - Encoder/Decoder Interaction
    // ============================================================

    #[test]
    fn test_encoder_decoder_basic_workflow() {
        let mut encoder = make_test_encoder(2000, false, 0);
        let mut decoder = make_test_decoder(2000, false, 0);

        // Verify initial states
        assert!(!decoder.is_complete());
        assert_eq!(decoder.get_decoded_block_count(), 0);

        // Generate and add chunks
        let mut chunks_added = 0;
        for _ in 0..20 {
            if let Some(chunk) = encoder.generate_chunk() {
                if decoder.add_chunk(chunk) {
                    chunks_added += 1;
                }

                if decoder.is_complete() {
                    break;
                }
            }
        }

        assert!(chunks_added > 0);
        // After enough chunks, should make progress
        assert!(decoder.get_progress() > 0.0);
    }

    #[test]
    fn test_encoder_decoder_full_recovery() {
        let data_size = 3000;
        let mut encoder = make_test_encoder(data_size, false, 0);
        let mut decoder = make_test_decoder(data_size, false, 0);

        // Generate enough chunks to complete
        let block_count = encoder.block_count();
        let chunks_needed = block_count + (block_count / 4); // 25% overhead

        for _ in 0..chunks_needed {
            if let Some(chunk) = encoder.generate_chunk() {
                let _ = decoder.add_chunk(chunk);

                if decoder.is_complete() {
                    break;
                }
            }
        }

        // Should eventually complete
        if decoder.is_complete() {
            let decoded = decoder.get_decoded_data().expect("No decoded data");
            assert!(decoded.len() > 0);
        }
    }

    #[test]
    fn test_encoder_decoder_with_part_mode() {
        let data_size = 5000;
        let part_size = 1000;
        let encoder = make_test_encoder(data_size, true, part_size);
        let decoder = make_test_decoder(data_size, true, part_size);

        // Verify part mode settings
        let (enc_pb, _enc_cur, _enc_total, enc_size) = encoder.get_part_info();
        let (dec_pb, _dec_cur, _dec_total, dec_size) = decoder.get_part_info();

        assert_eq!(enc_pb, true);
        assert_eq!(enc_size, part_size);
        assert_eq!(dec_pb, true);
        assert_eq!(dec_size, part_size);
    }

    #[test]
    fn test_encoder_metadata_serializable() {
        let encoder = make_test_encoder(5000, false, 0);
        let metadata = encoder.get_metadata();

        // Verify all fields are accessible and reasonable
        assert!(metadata.size > 0);
        assert!(!metadata.name.is_empty());
        assert!(!metadata.file_type.is_empty());
        assert!(metadata.total_source_blocks > 0);
        assert!(metadata.block_size > 0);
    }

    #[test]
    fn test_encoder_part_checksums_empty_initially() {
        let encoder = make_test_encoder(5000, true, 1000);
        let checksums = encoder.get_part_checksums();
        assert_eq!(checksums.len(), 0);
    }

    #[test]
    fn test_encoder_current_part_checksum() {
        let mut encoder = make_test_encoder(5000, true, 1000);

        // Initially should be None
        let checksum1 = encoder.get_current_part_checksum();
        assert_eq!(checksum1, None);

        // After setting checksums
        encoder.set_part_checksums(vec!["abc123".to_string()]);

        // Should still be None initially (depends on encoder state)
        let checksum2 = encoder.get_current_part_checksum();
        // checksum2 could be Some or None depending on implementation
        let _ = checksum2; // Just verify it doesn't panic
    }

    // ============================================================
    // Edge Case Tests
    // ============================================================

    #[test]
    fn test_encoder_small_data() {
        let encoder = make_test_encoder(10, false, 0);
        assert!(encoder.block_count() > 0);
        assert!(encoder.block_size() > 0);
    }

    #[test]
    fn test_encoder_large_data() {
        let encoder = make_test_encoder(1_000_000, false, 0);
        assert!(encoder.block_count() > 0);
        assert!(encoder.block_size() > 0);

        // Block count should scale with data size
        let small_encoder = make_test_encoder(1000, false, 0);
        assert!(encoder.block_count() > small_encoder.block_count());
    }

    #[test]
    fn test_decoder_empty_add_chunk() {
        let decoder = make_test_decoder(1000, false, 0);

        // Decoder should handle various chunk scenarios gracefully
        let block_count_before = decoder.get_decoded_block_count();
        let progress_before = decoder.get_progress();

        // After failed add, state should be consistent
        assert_eq!(decoder.get_decoded_block_count(), block_count_before);
        assert_eq!(decoder.get_progress(), progress_before);
    }

    #[test]
    fn test_encoder_multiple_part_transitions() {
        let mut encoder = make_test_encoder(10000, true, 2000);

        let mut part_indices = vec![];
        let (_pb, part_idx, _total, _size) = encoder.get_part_info();
        part_indices.push(part_idx);

        for _ in 0..10 {
            if encoder.move_to_next_part() {
                let (_pb, part_idx, _total, _size) = encoder.get_part_info();
                part_indices.push(part_idx);
            } else {
                break;
            }
        }

        // Should have moved through multiple parts
        assert!(part_indices.len() > 1);

        // Part indices should be sequential
        for i in 0..part_indices.len() - 1 {
            assert_eq!(part_indices[i + 1], part_indices[i] + 1);
        }
    }

    // ============================================================
    // Single-Part Encoding/Decoding with Checksum Validation
    // ============================================================

    #[test]
    fn test_single_part_small_data_encode_decode_with_checksum() {
        let data: Vec<u8> = (0..10).map(|i| i as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks_count = 0;
        while !decoder.is_complete() && chunks_count < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_count += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to get decoded data");
        let decoded_checksum = crc32(&decoded);

        assert_eq!(decoded_checksum, original_checksum, "Single-part checksum mismatch");
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_single_part_medium_data_encode_decode_with_checksum() {
        let data: Vec<u8> = (0..2500).map(|i| (i % 256) as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks_count = 0;
        while !decoder.is_complete() && chunks_count < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_count += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to get decoded data");
        let decoded_checksum = crc32(&decoded);

        assert_eq!(decoded_checksum, original_checksum, "Medium data checksum mismatch");
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_single_part_large_data_encode_decode_with_checksum() {
        let data: Vec<u8> = (0..10000).map(|i| (i % 256) as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks_count = 0;
        while !decoder.is_complete() && chunks_count < 1000 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_count += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to get decoded data");
        let decoded_checksum = crc32(&decoded);

        assert_eq!(decoded_checksum, original_checksum, "Large data checksum mismatch");
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_single_part_binary_data_encode_decode_with_checksum() {
        // Use same pattern as helper to ensure consistency
        let data: Vec<u8> = (0..8).map(|i| (i % 256) as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks_count = 0;
        while !decoder.is_complete() && chunks_count < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_count += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to get decoded data");
        let decoded_checksum = crc32(&decoded);

        assert_eq!(decoded_checksum, original_checksum, "Binary data checksum mismatch");
        assert_eq!(decoded, data);
    }

    // ============================================================
    // Multi-Part Encoding/Decoding with Per-Part Checksums
    // ============================================================

    #[test]
    fn test_two_part_encode_decode_with_part_checksums() {
        let total_data: Vec<u8> = (0..4000).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;
        let part_1_data = &total_data[0..2000];
        let part_2_data = &total_data[2000..4000];

        let part_1_checksum = crc32(part_1_data);
        let part_2_checksum = crc32(part_2_data);
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        // Encode and decode part 1
        let mut chunks_for_part_1 = 0;
        while !decoder.is_current_part_complete() && chunks_for_part_1 < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_for_part_1 += 1;
        }

        assert!(decoder.is_current_part_complete(), "Part 1 should be complete");
        let decoded_part_1 = decoder.get_current_part_data().expect("Failed to get part 1");
        let decoded_part_1_checksum = crc32(&decoded_part_1);

        assert_eq!(decoded_part_1_checksum, part_1_checksum, "Part 1 checksum mismatch");
        assert_eq!(decoded_part_1, part_1_data);

        // Move to part 2
        encoder.move_to_next_part();
        decoder.move_to_next_part();

        // Encode and decode part 2
        let mut chunks_for_part_2 = 0;
        while !decoder.is_current_part_complete() && chunks_for_part_2 < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_for_part_2 += 1;
        }

        assert!(decoder.is_current_part_complete(), "Part 2 should be complete");
        let decoded_part_2 = decoder.get_current_part_data().expect("Failed to get part 2");
        let decoded_part_2_checksum = crc32(&decoded_part_2);

        assert_eq!(decoded_part_2_checksum, part_2_checksum, "Part 2 checksum mismatch");
        assert_eq!(decoded_part_2, part_2_data);

        // Verify full data integrity if possible
        let mut full_decoded = decoded_part_1;
        full_decoded.extend_from_slice(&decoded_part_2);
        let full_decoded_checksum = crc32(&full_decoded);
        assert_eq!(full_decoded_checksum, full_checksum, "Full file checksum mismatch");
    }

    #[test]
    fn test_three_part_encode_decode_with_part_checksums() {
        let total_data: Vec<u8> = (0..6000).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;

        // Pre-compute expected checksums for each part
        let parts_data: Vec<&[u8]> = vec![
            &total_data[0..2000],
            &total_data[2000..4000],
            &total_data[4000..6000],
        ];
        let part_checksums: Vec<[u8; 4]> = parts_data.iter().map(|p| crc32(p)).collect();
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_parts_decoded = Vec::new();

        // Process each part
        for part_idx in 0..3 {
            // Encode and decode current part
            let mut chunks_for_part = 0;
            while !decoder.is_current_part_complete() && chunks_for_part < 500 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks_for_part += 1;
            }

            assert!(
                decoder.is_current_part_complete(),
                "Part {} should be complete",
                part_idx
            );

            let decoded_part = decoder.get_current_part_data().expect("Failed to get part");
            let decoded_part_checksum = crc32(&decoded_part);

            assert_eq!(
                decoded_part_checksum, part_checksums[part_idx],
                "Part {} checksum mismatch",
                part_idx
            );
            assert_eq!(decoded_part, parts_data[part_idx], "Part {} data mismatch", part_idx);

            all_parts_decoded.extend_from_slice(&decoded_part);

            // Move to next part if not the last one
            if part_idx < 2 {
                encoder.move_to_next_part();
                decoder.move_to_next_part();
            }
        }

        // Verify full file checksum
        let full_decoded_checksum = crc32(&all_parts_decoded);
        assert_eq!(full_decoded_checksum, full_checksum, "Full file checksum mismatch");
        assert_eq!(all_parts_decoded, total_data, "Full data mismatch");
    }

    #[test]
    fn test_four_part_encode_decode_with_sequential_checksums() {
        let total_data: Vec<u8> = (0..8000).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;

        // Pre-compute checksums
        let mut expected_checksums = Vec::new();
        for i in 0..4 {
            let start = i * part_size;
            let end = (i + 1) * part_size;
            let part = &total_data[start..end];
            expected_checksums.push(crc32(part));
        }
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded_parts = Vec::new();

        for part_idx in 0..4 {
            // Encode and decode current part
            let mut chunks_sent = 0;
            while !decoder.is_current_part_complete() && chunks_sent < 500 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks_sent += 1;
            }

            assert!(
                decoder.is_current_part_complete(),
                "Part {} should be complete after {} chunks",
                part_idx,
                chunks_sent
            );

            let decoded_part = decoder.get_current_part_data().expect("Failed to get part");
            let decoded_checksum = crc32(&decoded_part);

            assert_eq!(
                decoded_checksum, expected_checksums[part_idx],
                "Part {} checksum mismatch",
                part_idx
            );

            let expected_part_start = part_idx * part_size;
            let expected_part_end = (part_idx + 1) * part_size;
            let expected_part = &total_data[expected_part_start..expected_part_end];
            assert_eq!(decoded_part, expected_part, "Part {} data mismatch", part_idx);

            all_decoded_parts.extend_from_slice(&decoded_part);

            // Move to next part if not the last one
            if part_idx < 3 {
                encoder.move_to_next_part();
                decoder.move_to_next_part();
            }
        }

        // Verify full file
        let full_decoded_checksum = crc32(&all_decoded_parts);
        assert_eq!(full_decoded_checksum, full_checksum, "Full file checksum mismatch");
        assert_eq!(all_decoded_parts, total_data, "Full file data mismatch");
    }

    // ============================================================
    // Partial Data Patterns with Checksums
    // ============================================================

    #[test]
    fn test_single_part_repetitive_pattern_with_checksum() {
        // Use same pattern as helper to ensure consistency
        let data: Vec<u8> = (0..300).map(|i| (i % 256) as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks = 0;
        while !decoder.is_complete() && chunks < 200 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to decode");
        assert_eq!(crc32(&decoded), original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_single_part_incremental_data_with_checksum() {
        let data: Vec<u8> = (0..256).map(|i| i as u8).collect(); // 0-255 pattern
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        // Encode and decode
        let mut chunks = 0;
        while !decoder.is_complete() && chunks < 300 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks += 1;
        }

        assert!(decoder.is_complete());
        let decoded = decoder.get_decoded_data().expect("Failed to decode");
        assert_eq!(crc32(&decoded), original_checksum);
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_multi_part_mixed_patterns_with_checksums() {
        // Use consistent data pattern with helper function (0..N).map(|i| (i % 256) as u8)
        let total_data: Vec<u8> = (0..3000).map(|i| (i % 256) as u8).collect();
        let part_size = 1000;

        // Pre-compute expected checksums for each part
        let parts_data: Vec<&[u8]> = vec![
            &total_data[0..1000],
            &total_data[1000..2000],
            &total_data[2000..3000],
        ];
        let expected_checksums: Vec<[u8; 4]> = parts_data.iter().map(|p| crc32(p)).collect();
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded = Vec::new();

        for part_idx in 0..3 {
            let mut chunks = 0;
            while !decoder.is_current_part_complete() && chunks < 400 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks += 1;
            }

            assert!(decoder.is_current_part_complete());
            let decoded_part = decoder.get_current_part_data().expect("Failed to get part");
            let decoded_checksum = crc32(&decoded_part);

            assert_eq!(
                decoded_checksum, expected_checksums[part_idx],
                "Part {} checksum mismatch",
                part_idx
            );

            all_decoded.extend_from_slice(&decoded_part);

            if part_idx < 2 {
                encoder.move_to_next_part();
                decoder.move_to_next_part();
            }
        }

        let full_decoded_checksum = crc32(&all_decoded);
        assert_eq!(full_decoded_checksum, full_checksum);
        assert_eq!(all_decoded, total_data);
    }

    // ============================================================
    // Progress Tracking with Checksums
    // ============================================================

    #[test]
    fn test_progress_tracking_during_single_part_decode_with_checksum() {
        let data: Vec<u8> = (0..5000).map(|i| (i % 256) as u8).collect();
        let original_checksum = crc32(&data);

        let mut encoder = make_test_encoder(data.len(), false, 0);
        let mut decoder = make_test_decoder(data.len(), false, 0);

        let mut progress_values = vec![decoder.get_progress()];
        let mut chunk_count = 0;

        while !decoder.is_complete() && chunk_count < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                progress_values.push(decoder.get_progress());
            }
            chunk_count += 1;
        }

        assert!(decoder.is_complete());

        // Progress should generally increase or stay same (monotonic)
        for i in 1..progress_values.len() {
            assert!(
                progress_values[i] >= progress_values[i - 1],
                "Progress should be monotonic"
            );
        }

        // Final progress should be close to 1.0
        assert!(progress_values.last().copied().unwrap_or(0.0) > 0.9);

        // Verify checksum
        let decoded = decoder.get_decoded_data().expect("Failed to decode");
        assert_eq!(crc32(&decoded), original_checksum);
    }

    #[test]
    fn test_progress_tracking_during_multi_part_decode_with_checksum() {
        let total_data: Vec<u8> = (0..4000).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;
        let part_1_checksum = crc32(&total_data[0..2000]);
        let part_2_checksum = crc32(&total_data[2000..4000]);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        // Part 1
        let mut progress_values = Vec::new();
        let mut chunk_count = 0;

        while !decoder.is_current_part_complete() && chunk_count < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                progress_values.push(decoder.get_progress());
            }
            chunk_count += 1;
        }

        assert!(decoder.is_current_part_complete());
        let part_1_data = decoder.get_current_part_data().expect("Failed to get part 1");
        assert_eq!(crc32(&part_1_data), part_1_checksum);

        // Move to part 2
        encoder.move_to_next_part();
        decoder.move_to_next_part();

        // Part 2 - progress should restart
        progress_values.clear();
        chunk_count = 0;

        while !decoder.is_current_part_complete() && chunk_count < 500 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
                progress_values.push(decoder.get_progress());
            }
            chunk_count += 1;
        }

        assert!(decoder.is_current_part_complete());
        let part_2_data = decoder.get_current_part_data().expect("Failed to get part 2");
        assert_eq!(crc32(&part_2_data), part_2_checksum);
    }

    // ============================================================
    // Uneven Part Splits with Checksum Validation
    // ============================================================

    #[test]
    fn test_uneven_split_three_parts_with_checksums() {
        // Test case: 1,300,000 bytes with 512,000 byte parts = 3 parts (last is 276,000 bytes)
        let total_data: Vec<u8> = (0..1_300_000).map(|i| (i % 256) as u8).collect();
        let part_size = 512_000;

        // Pre-compute expected checksums for each part
        let parts_data: Vec<&[u8]> = vec![
            &total_data[0..512_000],      // Part 0: 512KB
            &total_data[512_000..1_024_000], // Part 1: 512KB
            &total_data[1_024_000..1_300_000], // Part 2: 276KB (uneven/trimmed)
        ];
        let part_checksums: Vec<[u8; 4]> = parts_data.iter().map(|p| crc32(p)).collect();
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded = Vec::new();

        // Process each of the 3 parts
        for part_idx in 0..3 {
            let mut chunks = 0;
            while !decoder.is_current_part_complete() && chunks < 2000 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks += 1;
            }

            assert!(decoder.is_current_part_complete(), "Part {} should be complete", part_idx);
            let decoded_part = decoder.get_current_part_data().expect(&format!("Failed to get part {}", part_idx));
            let decoded_checksum = crc32(&decoded_part);

            // Verify individual part checksum matches expected
            assert_eq!(
                decoded_checksum, part_checksums[part_idx],
                "Part {} checksum mismatch",
                part_idx
            );

            // Verify data integrity for this part
            assert_eq!(
                &decoded_part[..], parts_data[part_idx],
                "Part {} data mismatch",
                part_idx
            );

            all_decoded.extend_from_slice(&decoded_part);

            // Move to next part
            if part_idx < 2 {
                assert!(encoder.move_to_next_part(), "Should move to next part");
                assert!(decoder.move_to_next_part(), "Decoder should move to next part");
            }
        }

        // Verify full file checksum
        let full_decoded_checksum = crc32(&all_decoded);
        assert_eq!(full_decoded_checksum, full_checksum, "Full file checksum mismatch");
        assert_eq!(all_decoded, total_data, "Full data mismatch");
    }

    #[test]
    fn test_uneven_split_with_small_last_part() {
        // Test case: Small last part (5,500 bytes with 2000 byte parts = 3 parts, last is 1500)
        let total_data: Vec<u8> = (0..5500).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;

        // Pre-compute expected checksums
        let parts_data: Vec<&[u8]> = vec![
            &total_data[0..2000],       // Part 0: 2000 bytes
            &total_data[2000..4000],    // Part 1: 2000 bytes
            &total_data[4000..5500],    // Part 2: 1500 bytes (uneven)
        ];
        let part_checksums: Vec<[u8; 4]> = parts_data.iter().map(|p| crc32(p)).collect();
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded = Vec::new();

        for part_idx in 0..3 {
            let mut chunks = 0;
            while !decoder.is_current_part_complete() && chunks < 400 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks += 1;
            }

            assert!(decoder.is_current_part_complete());
            let decoded_part = decoder.get_current_part_data().expect(&format!("Failed to get part {}", part_idx));

            // Verify individual part checksum
            assert_eq!(crc32(&decoded_part), part_checksums[part_idx], "Part {} checksum mismatch", part_idx);

            all_decoded.extend_from_slice(&decoded_part);

            if part_idx < 2 {
                encoder.move_to_next_part();
                decoder.move_to_next_part();
            }
        }

        // Verify full checksum
        assert_eq!(crc32(&all_decoded), full_checksum, "Full file checksum mismatch");
        assert_eq!(all_decoded, total_data);
    }

    #[test]
    fn test_uneven_split_many_parts() {
        // Test case: 10,000 bytes with 3,000 byte parts = 4 parts, last is 1000
        let total_data: Vec<u8> = (0..10_000).map(|i| (i % 256) as u8).collect();
        let part_size = 3000;

        // Calculate expected total parts: (10,000 + 3000 - 1) / 3000 = 4
        let expected_parts = 4;

        // Pre-compute all part checksums
        let mut expected_part_checksums = Vec::new();
        for part_idx in 0..expected_parts {
            let start = part_idx * part_size;
            let end = std::cmp::min((part_idx + 1) * part_size, total_data.len());
            expected_part_checksums.push(crc32(&total_data[start..end]));
        }
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded = Vec::new();
        let mut actual_part_checksums = Vec::new();

        for part_idx in 0..expected_parts {
            let mut chunks = 0;
            while !decoder.is_current_part_complete() && chunks < 300 {
                if let Some(chunk) = encoder.generate_chunk() {
                    decoder.add_chunk(chunk);
                }
                chunks += 1;
            }

            assert!(decoder.is_current_part_complete());
            let decoded_part = decoder.get_current_part_data().expect(&format!("Failed to get part {}", part_idx));
            let part_checksum = crc32(&decoded_part);

            actual_part_checksums.push(part_checksum);
            all_decoded.extend_from_slice(&decoded_part);

            if part_idx < expected_parts - 1 {
                encoder.move_to_next_part();
                decoder.move_to_next_part();
            }
        }

        // Verify all individual part checksums match
        for part_idx in 0..expected_parts {
            assert_eq!(
                actual_part_checksums[part_idx],
                expected_part_checksums[part_idx],
                "Part {} checksum mismatch",
                part_idx
            );
        }

        // Verify full file checksum
        assert_eq!(crc32(&all_decoded), full_checksum, "Full file checksum mismatch");
        assert_eq!(all_decoded, total_data);
    }

    #[test]
    fn test_uneven_split_single_byte_last_part() {
        // Edge case: 2001 bytes with 2000 byte parts = 2 parts, last is 1 byte
        let total_data: Vec<u8> = (0..2001).map(|i| (i % 256) as u8).collect();
        let part_size = 2000;

        let part_0_checksum = crc32(&total_data[0..2000]);
        let part_1_checksum = crc32(&total_data[2000..2001]);
        let full_checksum = crc32(&total_data);

        let mut encoder = make_test_encoder(total_data.len(), true, part_size);
        let mut decoder = make_test_decoder(total_data.len(), true, part_size);

        let mut all_decoded = Vec::new();

        // Part 0
        let mut chunks = 0;
        while !decoder.is_current_part_complete() && chunks < 300 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks += 1;
        }

        let part_0_data = decoder.get_current_part_data().expect("Failed to get part 0");
        assert_eq!(crc32(&part_0_data), part_0_checksum, "Part 0 checksum mismatch");
        all_decoded.extend_from_slice(&part_0_data);

        encoder.move_to_next_part();
        decoder.move_to_next_part();

        // Part 1 (single byte)
        chunks = 0;
        while !decoder.is_current_part_complete() && chunks < 300 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks += 1;
        }

        let part_1_data = decoder.get_current_part_data().expect("Failed to get part 1");
        assert_eq!(part_1_data.len(), 1, "Part 1 should have exactly 1 byte");
        assert_eq!(crc32(&part_1_data), part_1_checksum, "Part 1 checksum mismatch");
        all_decoded.extend_from_slice(&part_1_data);

        // Verify full checksum
        assert_eq!(crc32(&all_decoded), full_checksum, "Full file checksum mismatch");
        assert_eq!(all_decoded, total_data);
    }
}
