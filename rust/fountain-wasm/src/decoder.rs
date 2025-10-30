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
}

impl FountainDecoder {
    pub fn new(metadata: FountainMetadata) -> Self {
        Self {
            metadata,
            decoded_blocks: HashMap::new(),
            chunks: Vec::new(),
            received_chunk_count: 0,
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
        self.decoded_blocks.len() == self.metadata.total_source_blocks
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

    /// Get metadata
    pub fn get_metadata(&self) -> FountainMetadata {
        self.metadata.clone()
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
