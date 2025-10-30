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

    #[test]
    fn test_e2e_small_file_with_checksum() {
        let data = generate_test_data(100);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(25);

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

        // Encode and decode
        let mut chunks_sent = 0;
        while !decoder.is_complete() && chunks_sent < 100 {
            if let Some(chunk) = encoder.generate_chunk() {
                decoder.add_chunk(chunk);
            }
            chunks_sent += 1;
        }

        assert!(decoder.is_complete(), "Decoder should be complete");
        assert!(chunks_sent < 20, "Should decode with reasonable overhead");

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded.len(), data.len(), "Decoded data length mismatch");

        // Validate checksum
        let decoded_checksum = crc32(&decoded);
        assert_eq!(
            decoded_checksum, original_checksum,
            "Checksum mismatch: expected {}, got {}",
            original_checksum, decoded_checksum
        );

        // Validate data integrity
        assert_eq!(decoded, data, "Decoded data does not match original");
    }

    #[test]
    fn test_e2e_medium_file_with_checksum() {
        let data = generate_test_data(5000);
        let original_checksum = crc32(&data);

        let options = FountainEncoderOptions::default().with_block_size(400);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "medium.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "large.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "random.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "zeros.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "ones.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "lossy.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "progress.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let options = FountainEncoderOptions::default()
            .with_block_size(400);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "parts.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

            // Validate part checksum
            let part_checksum = crc32(&part_data);
            assert!(
                !part_checksum.is_empty(),
                "Part checksum should not be empty"
            );

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

        let options = FountainEncoderOptions::default()
            .with_block_size(400);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "parts_check.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "single.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false, 0, None,
        );

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
