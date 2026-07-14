#[cfg(test)]
mod decoder_tests {
    use crate::decoder::FountainDecoder;
    use crate::encoder::FountainEncoder;
    use crate::types::{FountainChunk, FountainEncoderOptions};

    fn options_with_block_size(block_size: usize) -> FountainEncoderOptions {
        let mut options = FountainEncoderOptions::default();
        options.block_size = block_size;
        options
    }

    #[test]
    fn test_decoder_simple() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
            false,
            0,
            None,
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
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
        let options = options_with_block_size(block_size);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
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

        let options = options_with_block_size(block_size);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
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
        // Then max(ceil(2 * 0.05), 10) = 10 chunks for subsequent decodes
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have some blocks decoded from first decode (at 3 chunks)
        // Check by seeing if decoder has decoded blocks
        let decoded_blocks = decoder.get_decoded_block_count();
        assert!(
            decoded_blocks > 0,
            "First decode should have happened at 3 chunks (decoded {} blocks)",
            decoded_blocks
        );

        // Should have 2 pending chunks (need 10 for next decode)
        let pending_count = decoder.get_pending_chunk_count();
        assert!(
            pending_count > 0,
            "Should have pending chunks (need 10 for next decode)"
        );

        // Flush pending chunks
        decoder.flush_pending_chunks();

        // Verify flush processed pending chunks
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "No pending chunks after flush"
        );
    }

    #[test]
    fn test_flush_required_to_complete_decoding() {
        // Create a very small file that can be decoded with 2-3 chunks
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.05), 10) = 10 for next decode
        let data = vec![1, 2, 3, 4];
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Add 7 chunks: First 3 trigger first decode, remaining 4 are pending (need 10)
        // This should have enough data to complete, but chunks are pending
        let mut chunk_count = 0;
        while chunk_count < 7 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
                chunk_count += 1;
            }
        }

        // May or may not be complete yet depending on chunks received
        // But should have pending chunks (need 10 for next automatic decode)
        let pending = decoder.get_pending_chunk_count();
        assert!(
            pending > 0,
            "Should have pending chunks (need 10 for next decode, only added 4 more)"
        );

        // Flush pending chunks - this processes all pending
        decoder.flush_pending_chunks();

        // After flush, should have no pending
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "No pending after flush"
        );

        // Should be complete or very close
        if !decoder.is_complete() {
            // Add a few more and flush again
            for _ in 0..5 {
                if let Some(chunk) = encoder.generate_chunk() {
                    let chunk_key = format!(
                        "{}:{}:{}:{}",
                        chunk.seed,
                        chunk.degree,
                        chunk.indices.first().unwrap_or(&0),
                        chunk.indices.last().unwrap_or(&0)
                    );
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
        let options = options_with_block_size(2);

        let encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Flush without adding any chunks
        let blocks_decoded = decoder.flush_pending_chunks();
        assert_eq!(blocks_decoded, 0, "Flushing empty queue should return 0");
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Pending count should be 0"
        );
    }

    #[test]
    fn test_flush_resets_throttle_counter() {
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.05), 10) = 10 for subsequent decodes
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");
        let mut decoder = FountainDecoder::new(metadata);

        // Add 5 chunks: First 3 trigger first decode, next 2 are pending
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify pending (need 10 for next decode, only added 2 more)
        assert!(
            decoder.get_pending_chunk_count() > 0,
            "Should have 2 pending chunks"
        );

        // Flush (should reset counter and process pending)
        decoder.flush_pending_chunks();
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "No pending after flush"
        );

        // Add 5 more chunks (should also start pending - need 10 total)
        for _ in 0..5 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Verify new chunks are pending (counter was reset)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(
            pending_after > 0,
            "Counter should have been reset, new chunks pending"
        );
        assert!(
            pending_after <= 5,
            "Should have at most 5 new pending chunks"
        );
    }

    #[test]
    fn test_get_pending_chunk_count_accuracy() {
        // With adaptive: 2 blocks need ceil(2 * 1.10) = 3 for first decode
        // Then max(ceil(2 * 0.05), 10) = 10 for subsequent decodes
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
                assert_eq!(
                    decoder.get_pending_chunk_count(),
                    i,
                    "Pending count should be {} before first decode",
                    i
                );
            }
        }

        // Chunk 3: triggers first decode, count resets to 0
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
            assert_eq!(
                decoder.get_pending_chunk_count(),
                0,
                "Count should be 0 after first decode at 3 chunks"
            );
        }

        // Chunks 4-5: pending again (count: 1, 2)
        for i in 1..=2 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
                assert_eq!(
                    decoder.get_pending_chunk_count(),
                    i,
                    "Pending count should be {} after first decode",
                    i
                );
            }
        }

        // Flush and verify count is 0
        decoder.flush_pending_chunks();
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Count should be 0 after flush"
        );
    }

    #[test]
    fn test_set_get_throttle_count() {
        let data = vec![1, 2, 3, 4];
        let options = options_with_block_size(2);

        let encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        // Set threshold to 3
        decoder.set_decode_throttle_count(3);

        // Add 2 chunks (below threshold)
        for _ in 0..2 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Should have 2 pending
        let pending_before = decoder.get_pending_chunk_count();
        assert!(pending_before >= 2, "Should have at least 2 pending chunks");

        // Add 3rd chunk (exactly at threshold - should trigger)
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Pending count should be 0 or very low (processed at threshold)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(
            pending_after < pending_before,
            "Processing should have occurred at threshold"
        );
    }

    // ========================================
    // process_binary_chunk() Tests
    // ========================================

    #[test]
    fn test_process_binary_chunk_successful() {
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Generate a chunk and serialize it to binary
        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process binary chunk
            let result = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

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
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Create malformed binary data (too short)
        let invalid_data = vec![0u8; 5];

        let result = decoder.process_binary_chunk(&invalid_data, total_source_blocks, "");

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
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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

            let result = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

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
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk twice
            let result1 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // First should be processed
            match result1.status {
                crate::types::ChunkStatus::Processed => {}
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Flush to ensure it's processed
            decoder.flush_pending_chunks();

            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Second should be duplicate
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!(
                    "Expected Duplicate status on second chunk, got {:?}",
                    result2.status
                ),
            }
        }
    }

    #[test]
    fn test_process_binary_chunk_completion() {
        let data = vec![1, 2, 3, 4];
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
        let options = options_with_block_size(4);
        let part_size = 6; // 2 parts: [1,2,3,4,5,6] and [7,8,9,10,11,12]

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

                result = Some(decoder.process_binary_chunk(&binary_data, total_source_blocks, ""));

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
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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

                let result = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

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
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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

                let result =
                    decoder.process_binary_chunk(&binary_data, total_source_blocks, wrong_checksum);

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
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk 5 times
            for i in 0..5 {
                let result = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

                if i == 0 {
                    // First should be processed
                    match result.status {
                        crate::types::ChunkStatus::Processed => {}
                        _ => panic!(
                            "Expected Processed status on first chunk, got {:?}",
                            result.status
                        ),
                    }
                } else {
                    // All subsequent should be duplicates
                    match result.status {
                        crate::types::ChunkStatus::Duplicate => {}
                        _ => panic!(
                            "Expected Duplicate status on chunk #{}, got {:?}",
                            i, result.status
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn test_deduplication_does_not_increment_received_count() {
        // Test that duplicates don't increment the received_chunk_count
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process same chunk 3 times
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(
                decoder.get_received_chunk_count(),
                1,
                "First chunk should increment count to 1"
            );

            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(
                decoder.get_received_chunk_count(),
                1,
                "Duplicate should not increment count"
            );

            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            assert_eq!(
                decoder.get_received_chunk_count(),
                1,
                "Second duplicate should not increment count"
            );
        }
    }

    #[test]
    fn test_deduplication_session_id_change_clears_cache() {
        // Test that changing session ID clears the dedup cache
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                crate::types::ChunkStatus::Processed => {}
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Process same chunk again - should be duplicate
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!("Expected Duplicate status before session change"),
            }

            // Change session ID
            decoder.set_session_id(200);

            // Process same chunk again - should be processed (not duplicate) after session change
            let result3 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result3.status {
                crate::types::ChunkStatus::Processed => {}
                _ => panic!(
                    "Expected Processed status after session change, got {:?}",
                    result3.status
                ),
            }
        }
    }

    #[test]
    fn test_deduplication_interleaved_duplicates() {
        // Test duplicates mixed with new chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                    crate::types::ChunkStatus::Duplicate => {}
                    _ => panic!("Expected Duplicate for {}, got {:?}", desc, result.status),
                }
            } else {
                match result.status {
                    crate::types::ChunkStatus::Processed => {}
                    _ => panic!("Expected Processed for {}, got {:?}", desc, result.status),
                }
            }
        }

        // Verify received count is 3 (not 6)
        assert_eq!(
            decoder.get_received_chunk_count(),
            3,
            "Should only count 3 unique chunks"
        );
    }

    #[test]
    fn test_deduplication_chunk_key_consistency() {
        // Test that chunk keys are generated consistently for the same chunk
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            // Create chunk key
            let chunk_key =
                crate::parser::create_chunk_key(chunk.seed, chunk.degree, &chunk.indices);

            // Check if it's a duplicate (should be false initially)
            assert!(
                !decoder.is_chunk_duplicate(&chunk_key),
                "Initial chunk should not be marked as duplicate"
            );

            // Add the chunk key
            decoder.add_chunk_key(chunk_key.clone());

            // Check if it's now a duplicate (should be true)
            assert!(
                decoder.is_chunk_duplicate(&chunk_key),
                "Chunk should now be marked as duplicate"
            );

            // Recreate the same chunk key
            let chunk_key2 =
                crate::parser::create_chunk_key(chunk.seed, chunk.degree, &chunk.indices);

            // Should be the same
            assert_eq!(
                chunk_key, chunk_key2,
                "Chunk keys should be identical for same chunk"
            );
            assert!(
                decoder.is_chunk_duplicate(&chunk_key2),
                "Recreated chunk key should also be duplicate"
            );
        }
    }

    #[test]
    fn test_deduplication_many_chunks() {
        // Test deduplication with many chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!("Expected all chunks to be duplicates on second pass"),
            }
        }

        // Count should still be 20
        assert_eq!(
            decoder.get_received_chunk_count(),
            20,
            "Count should not increase for duplicates"
        );
    }

    #[test]
    fn test_deduplication_with_progress() {
        // Test that duplicates maintain correct progress reporting
        let data = vec![1, 2, 3, 4];
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!("Expected Duplicate status"),
            }

            // Progress should be the same (duplicates return current progress)
            assert_eq!(
                result2.overall_progress, progress1,
                "Progress should not change for duplicate"
            );
            assert_eq!(
                result2.decoded_block_count, decoded1,
                "Decoded count should not change for duplicate"
            );
        }
    }

    #[test]
    fn test_deduplication_session_id_same_does_not_clear() {
        // Test that setting the same session ID does NOT clear the cache
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                crate::types::ChunkStatus::Processed => {}
                _ => panic!("Expected Processed status on first chunk"),
            }

            // Set same session ID again
            decoder.set_session_id(100);

            // Process same chunk again - should still be duplicate (cache not cleared)
            let result2 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            match result2.status {
                crate::types::ChunkStatus::Duplicate => {}
                _ => panic!(
                    "Expected Duplicate status after setting same session ID, got {:?}",
                    result2.status
                ),
            }
        }
    }

    #[test]
    fn test_deduplication_does_not_add_to_pending_queue() {
        // Test that duplicates don't get added to the pending chunks queue
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
            assert_eq!(
                pending_after_first, 1,
                "First chunk should be in pending queue"
            );

            // Process duplicate
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let pending_after_duplicate = decoder.get_pending_chunk_count();
            assert_eq!(
                pending_after_duplicate, 1,
                "Duplicate should NOT be added to pending queue"
            );

            // Process duplicate again
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");
            let pending_after_second_dup = decoder.get_pending_chunk_count();
            assert_eq!(
                pending_after_second_dup, 1,
                "Second duplicate should NOT be added to pending queue"
            );
        }
    }

    #[test]
    fn test_deduplication_does_not_decode_blocks() {
        // Test that duplicates don't cause any blocks to be decoded
        let data = vec![1, 2, 3, 4];
        let options = options_with_block_size(2);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
            assert_eq!(
                result2.decoded_block_count, decoded_count_after_first,
                "Duplicate should not decode additional blocks"
            );
            assert_eq!(
                result2.overall_progress, progress_after_first,
                "Duplicate should not change progress"
            );
            assert_eq!(
                result2.decoded_block_indices, indices_after_first,
                "Duplicate should not change decoded block indices"
            );

            // Process another duplicate
            let result3 = decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Still no changes
            assert_eq!(
                result3.decoded_block_count, decoded_count_after_first,
                "Second duplicate should not decode additional blocks"
            );
            assert_eq!(
                result3.overall_progress, progress_after_first,
                "Second duplicate should not change progress"
            );
        }
    }

    #[test]
    fn test_deduplication_does_not_affect_subsequent_unique_chunks() {
        // Test that after processing duplicates, new unique chunks still work correctly
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
        assert!(matches!(
            result1.status,
            crate::types::ChunkStatus::Processed
        ));
        let count_after_1 = decoder.get_received_chunk_count();
        assert_eq!(count_after_1, 1);

        // Process chunk1 duplicate
        let result1_dup = decoder.process_binary_chunk(&binary1, total_source_blocks, "");
        assert!(matches!(
            result1_dup.status,
            crate::types::ChunkStatus::Duplicate
        ));
        let count_after_1_dup = decoder.get_received_chunk_count();
        assert_eq!(count_after_1_dup, 1, "Duplicate should not increment count");

        // Process chunk2 (unique)
        let result2 = decoder.process_binary_chunk(&binary2, total_source_blocks, "");
        assert!(matches!(
            result2.status,
            crate::types::ChunkStatus::Processed
        ));
        let count_after_2 = decoder.get_received_chunk_count();
        assert_eq!(count_after_2, 2, "New chunk should increment count");

        // Process chunk1 duplicate again
        let result1_dup2 = decoder.process_binary_chunk(&binary1, total_source_blocks, "");
        assert!(matches!(
            result1_dup2.status,
            crate::types::ChunkStatus::Duplicate
        ));
        let count_after_1_dup2 = decoder.get_received_chunk_count();
        assert_eq!(
            count_after_1_dup2, 2,
            "Duplicate should not increment count"
        );

        // Process chunk3 (unique)
        let result3 = decoder.process_binary_chunk(&binary3, total_source_blocks, "");
        assert!(matches!(
            result3.status,
            crate::types::ChunkStatus::Processed
        ));
        let count_after_3 = decoder.get_received_chunk_count();
        assert_eq!(count_after_3, 3, "New chunk should increment count");

        // Process chunk2 duplicate
        let result2_dup = decoder.process_binary_chunk(&binary2, total_source_blocks, "");
        assert!(matches!(
            result2_dup.status,
            crate::types::ChunkStatus::Duplicate
        ));
        let final_count = decoder.get_received_chunk_count();
        assert_eq!(final_count, 3, "Final count should be 3 unique chunks");
    }

    #[test]
    fn test_deduplication_zero_blocks_decoded_in_result() {
        // Test that duplicate result reports zero blocks decoded
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let options = options_with_block_size(4);

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        if let Some(chunk) = encoder.generate_chunk() {
            let binary_data = crate::parser::serialize_chunk_to_binary(&chunk, false);

            // Process first time
            decoder.process_binary_chunk(&binary_data, total_source_blocks, "");

            // Process duplicate - check internal result
            let chunk_dup =
                crate::parser::parse_binary_chunk(&binary_data, false, total_source_blocks)
                    .unwrap();
            let chunk_key = crate::parser::create_chunk_key(
                chunk_dup.chunk.seed,
                chunk_dup.chunk.degree,
                &chunk_dup.chunk.indices,
            );

            let process_result = decoder.process_chunk_with_validation(chunk_dup.chunk, chunk_key);

            // Should be duplicate with zero blocks decoded
            assert!(process_result.is_duplicate, "Should be marked as duplicate");
            assert_eq!(
                process_result.blocks_decoded, 0,
                "Duplicate should decode zero blocks"
            );
            assert!(
                process_result.part_complete_info.is_none(),
                "Duplicate should have no part completion info"
            );
        }
    }

    // ========================================
    // Adaptive Decoding Strategy Tests
    // ========================================

    #[test]
    fn test_adaptive_small_file_less_than_10_chunks() {
        // Test that files requiring less than 10 chunks still decode successfully
        // This verifies the "max(5%, 10)" logic works when total chunks < 10
        let data = vec![1, 2, 3, 4]; // Very small file: 4 bytes
        let options = options_with_block_size(2); // 2 blocks total

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 2, "Should have 2 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // With adaptive strategy:
        // - First decode needs: ceil(2 * 1.10) = 3 chunks
        // - After that: max(ceil(2 * 0.05), 10) = max(1, 10) = 10 chunks
        // But we should still be able to complete with very few chunks via flush

        let mut chunks_added = 0;
        let mut completed = false;

        // Add chunks until we have enough
        while chunks_added < 50 && !completed {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );

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
        assert!(
            chunks_added < 15,
            "Should complete with reasonable number of chunks (got {})",
            chunks_added
        );

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data, "Decoded data should match original");
    }

    #[test]
    fn test_adaptive_110_percent_threshold_first_decode() {
        // Test that first decode waits for 110% of required chunks
        let data = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 10 bytes
        let options = options_with_block_size(2); // 5 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 5, "Should have 5 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // 110% of 5 blocks = ceil(5.5) = 6 chunks required for first decode
        let required_for_first_decode = (5.0_f64 * 1.10).ceil() as usize;
        assert_eq!(
            required_for_first_decode, 6,
            "Should require 6 chunks for first decode"
        );

        // Add exactly required_for_first_decode - 1 chunks
        for _ in 0..(required_for_first_decode - 1) {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Should have pending chunks (not processed yet)
        let pending_before = decoder.get_pending_chunk_count();
        assert!(
            pending_before > 0,
            "Should have pending chunks before threshold"
        );

        // Add one more chunk to reach threshold
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have processed chunks (pending should be 0 or very low)
        let pending_after = decoder.get_pending_chunk_count();
        assert!(
            pending_after < pending_before,
            "Should have processed chunks at 110% threshold (pending: {} -> {})",
            pending_before,
            pending_after
        );
    }

    #[test]
    fn test_validation_retries_until_first_block_then_accumulates() {
        let data = vec![0u8; 100];
        let options = options_with_block_size(1);
        let encoder = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        let total_source_blocks = metadata.total_source_blocks;
        let mut decoder = FountainDecoder::new(metadata);

        // Reach the 10-chunk validation threshold with chunks that cannot yet
        // produce a singleton source block.
        for seed in 0..10 {
            let chunk = FountainChunk::new_unchecked(seed, 2, vec![0, 1], vec![0]);
            let binary = crate::parser::serialize_chunk_to_binary(&chunk, false);
            let result = decoder.process_binary_chunk(&binary, total_source_blocks, "");
            assert!(!result.real_decoding_started);
        }
        assert_eq!(decoder.get_decoded_block_count(), 0);
        assert_eq!(decoder.get_pending_chunk_count(), 0);

        // The next chunk must trigger another validation decode immediately.
        let singleton = FountainChunk::new_unchecked(10, 1, vec![0], vec![0]);
        let binary = crate::parser::serialize_chunk_to_binary(&singleton, false);
        let validation_result =
            decoder.process_binary_chunk(&binary, total_source_blocks, "");
        assert!(validation_result.decoded_block_count > 0);
        assert!(!validation_result.real_decoding_started);

        // Once validation succeeds, chunks accumulate without another decode.
        let accumulated = FountainChunk::new_unchecked(11, 2, vec![2, 3], vec![0]);
        let binary = crate::parser::serialize_chunk_to_binary(&accumulated, false);
        let accumulation_result =
            decoder.process_binary_chunk(&binary, total_source_blocks, "");
        assert!(!accumulation_result.real_decoding_started);
        assert_eq!(decoder.get_pending_chunk_count(), 1);

        let full_decode_threshold = (total_source_blocks as f64 * 1.10).ceil() as u32;
        for seed in 12..(full_decode_threshold - 1) {
            let chunk = FountainChunk::new_unchecked(seed, 2, vec![2, 3], vec![0]);
            let binary = crate::parser::serialize_chunk_to_binary(&chunk, false);
            let result = decoder.process_binary_chunk(&binary, total_source_blocks, "");
            assert!(!result.real_decoding_started);
        }

        // Reaching the configured 110% threshold starts the real decode and
        // clears accumulation.
        let threshold_chunk =
            FountainChunk::new_unchecked(full_decode_threshold - 1, 2, vec![2, 3], vec![0]);
        let binary = crate::parser::serialize_chunk_to_binary(&threshold_chunk, false);
        let decoding_result = decoder.process_binary_chunk(&binary, total_source_blocks, "");
        assert!(decoding_result.real_decoding_started);
        assert_eq!(decoder.get_pending_chunk_count(), 0);
    }

    #[test]
    fn test_adaptive_incremental_threshold_after_first_decode() {
        // Test that after first decode, threshold is max(5%, 10 chunks)
        // Also tests early decode at max(10, 2%) chunks
        let data = vec![0u8; 1000]; // Large file to ensure 5% > 10
        let options = options_with_block_size(20); // 50 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(metadata.total_source_blocks, 50, "Should have 50 blocks");

        let mut decoder = FountainDecoder::new(metadata);

        // Strategy: Early decode at max(10, 2%) = 10 chunks, then 110% decode at 55 chunks
        // After 110%: max(ceil(50 * 0.05), 10) = max(3, 10) = 10 chunks

        // Add chunks to trigger both early and first decode
        let first_decode_threshold = (50.0_f64 * 1.10).ceil() as usize; // 55
        for _ in 0..first_decode_threshold {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Early decode at 10 + first real decode at 55 should have processed all pending
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Decodes at 10 and 55 should have processed all pending"
        );

        // Now test incremental threshold (should be 10 chunks since 5% of 50 = 2.5 < 10)
        for i in 1..=9 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
            // Should still have pending chunks (threshold is 10)
            assert_eq!(
                decoder.get_pending_chunk_count(),
                i,
                "Should have {} pending chunks before incremental threshold",
                i
            );
        }

        // Add 10th chunk - should trigger decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // Should have processed at 10 chunk threshold
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Should have processed chunks at incremental threshold of 10"
        );
    }

    #[test]
    fn test_adaptive_complete_single_part_file_decode() {
        // Test complete decode flow for a single-part file with adaptive strategy
        let data = vec![0u8; 200]; // 200 bytes
        let options = options_with_block_size(10); // 20 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
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
                    assert!(
                        result.completion_data.is_some(),
                        "Should have completion data"
                    );

                    let completion_data = result.completion_data.unwrap();
                    assert_eq!(
                        completion_data.data.len(),
                        200,
                        "Decoded data should be 200 bytes"
                    );
                    assert!(completion_data.integrity_ok, "Checksum should be valid");
                    assert_eq!(completion_data.expected_checksum, expected_checksum);
                    assert_eq!(completion_data.actual_checksum, expected_checksum);
                    break;
                }
            }
        }

        assert!(completed, "Should complete decoding");
        assert!(
            chunks_added >= 22,
            "Should need at least 110% of blocks (22 chunks)"
        );
        assert!(
            chunks_added < 100,
            "Should complete reasonably fast (got {} chunks)",
            chunks_added
        );

        let decoded = decoder.get_decoded_data().unwrap();
        assert_eq!(decoded, data, "Decoded data should match original");
    }

    #[test]
    fn test_adaptive_multi_part_first_decode_110_percent() {
        // Test that 110% threshold applies to each part separately in multi-part mode
        // Also tests early decode at max(10, 2%) chunks
        let data = vec![0u8; 200]; // 200 bytes
        let options = options_with_block_size(10); // 20 blocks total
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

        // Part 0: Should have 10 blocks
        // Early decode at max(10, 2%) = 10 chunks, then 110% decode at ceil(10 * 1.10) = 11 chunks
        let part0_blocks = decoder.get_current_part_total_block_count();
        assert_eq!(part0_blocks, 10, "Part 0 should have 10 blocks");

        let part0_threshold = (part0_blocks as f64 * 1.10).ceil() as usize;
        assert_eq!(
            part0_threshold, 11,
            "Part 0 should need 11 chunks for first real decode"
        );

        // Add 10 chunks - should trigger early decode at 10
        for _ in 0..10 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // At 10 chunks, early decode should have processed all pending
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Early decode at 10 chunks should have processed all pending"
        );

        // Add 11th chunk - should trigger 110% decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        // At 11 chunks total, 110% decode should have processed the 1 pending chunk
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "110% decode at 11 chunks should have processed pending chunk"
        );

        // Verify the adaptive strategy is working per-part
        // The key point is that each part gets its own 110% threshold, not the global block count
    }

    #[test]
    fn test_adaptive_percentage_based_threshold_for_large_file() {
        // Test that for very large files, the 5% threshold is used (not 10 chunks)
        // Create a file with 1000 blocks, so 5% = 50 chunks > 10 chunks
        // Also tests early decode at max(10, 2%) = 20 chunks, then 110% decode at 1100 chunks
        let data = vec![0u8; 10000]; // 10000 bytes
        let options = options_with_block_size(10); // 1000 blocks

        let mut encoder = FountainEncoder::new(
            data.clone(),
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            false,
            0,
            None,
        );

        let metadata = encoder.get_metadata();
        assert_eq!(
            metadata.total_source_blocks, 1000,
            "Should have 1000 blocks"
        );

        let mut decoder = FountainDecoder::new(metadata);

        // Early decode at max(10, ceil(1000 * 0.02)) = max(10, 20) = 20 chunks, then 110% decode at 1100 chunks
        let first_decode_threshold = (1000.0_f64 * 1.10).ceil() as usize;
        assert_eq!(first_decode_threshold, 1100);

        // Add chunks to trigger 110% decode (early decode at 20 will happen automatically)
        for _ in 0..first_decode_threshold {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // 110% decode should have been triggered (early decode at 20 already happened)
        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "110% decode should have processed all pending"
        );

        // Now test incremental threshold
        // For 1000 blocks: max(ceil(1000 * 0.05), 10) = max(50, 10) = 50 chunks
        let incremental_threshold = ((1000.0_f64 * 0.05).ceil() as usize).max(10);
        assert_eq!(
            incremental_threshold, 50,
            "Incremental threshold should be 50 (5% of 1000)"
        );

        // Add 49 chunks - should stay pending
        for _ in 0..49 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        assert_eq!(
            decoder.get_pending_chunk_count(),
            49,
            "Should have 49 pending chunks"
        );

        // Add 50th chunk - should trigger decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        assert_eq!(
            decoder.get_pending_chunk_count(),
            0,
            "Should have processed at 5% threshold (50 chunks)"
        );
    }

    #[test]
    fn test_adaptive_part_reset_on_transition() {
        // Test that first_decode_attempted flag resets when moving to next part
        // With early decode: Part 1 should trigger at max(10, 2%) = 10 chunks (early), then 110% (11 chunks)
        let data = vec![0u8; 200]; // 200 bytes
        let options = options_with_block_size(10); // 20 blocks
        let part_size = 100; // 2 parts, 10 blocks each

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

        // Part 0: 10 blocks, early decode at 10 chunks, 110% at 11 chunks
        let part0_blocks = decoder.get_current_part_total_block_count();
        assert_eq!(part0_blocks, 10, "Part 0 should have 10 blocks");

        // Add chunks for part 0 to complete it
        while !decoder.is_current_part_complete() {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        // Move to part 1
        decoder.move_to_next_part();

        // Part 1: flag should have reset, so it should trigger early decode at 10 chunks
        let part1_blocks = decoder.get_current_part_total_block_count();
        assert_eq!(part1_blocks, 10, "Part 1 should have 10 blocks");

        // Add 9 chunks - should stay pending (no trigger yet)
        for _ in 0..9 {
            if let Some(chunk) = encoder.generate_chunk() {
                let chunk_key = format!(
                    "{}:{}:{}:{}",
                    chunk.seed,
                    chunk.degree,
                    chunk.indices.first().unwrap_or(&0),
                    chunk.indices.last().unwrap_or(&0)
                );
                decoder.process_chunk_with_validation(chunk, chunk_key);
            }
        }

        let pending_at_9 = decoder.get_pending_chunk_count();
        assert_eq!(
            pending_at_9, 9,
            "Part 1 should have 9 pending chunks before early decode"
        );

        // Add 10th chunk - early decode should trigger (confirming flag reset)
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        let pending_at_10 = decoder.get_pending_chunk_count();
        assert_eq!(
            pending_at_10, 0,
            "Part 1 should trigger early decode at 10 chunks, confirming flag reset"
        );

        // Add 11th chunk - should trigger 110% decode
        if let Some(chunk) = encoder.generate_chunk() {
            let chunk_key = format!(
                "{}:{}:{}:{}",
                chunk.seed,
                chunk.degree,
                chunk.indices.first().unwrap_or(&0),
                chunk.indices.last().unwrap_or(&0)
            );
            decoder.process_chunk_with_validation(chunk, chunk_key);
        }

        let pending_at_11 = decoder.get_pending_chunk_count();
        assert_eq!(
            pending_at_11, 0,
            "Part 1 should also process at 110% threshold (11 chunks)"
        );
    }
}
