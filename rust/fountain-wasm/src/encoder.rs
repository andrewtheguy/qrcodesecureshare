use crate::distribution::{build_robust_soliton, calculate_max_degree, sample_degree_with_doping_lcg};
use crate::rng::{create_rng, select_indices_with_rng};
use crate::types::{FountainChunk, FountainEncoderOptions, FountainMetadata};
use crate::xor::xor_blocks;

pub struct FountainEncoder {
    /// Source data split into blocks
    blocks: Vec<Vec<u8>>,
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
}

impl FountainEncoder {
    pub fn new(
        data: Vec<u8>,
        name: String,
        file_type: String,
        timestamp: f64,
        options: FountainEncoderOptions,
        seed_offset: Option<u32>,
    ) -> Self {
        let block_size = options.block_size;
        let total_size = data.len();

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

        let metadata = FountainMetadata::new(
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

        Self {
            blocks,
            metadata,
            degree_distribution,
            max_degree,
            options,
            current_seed: 0,
            seed_offset: offset,
        }
    }

    /// Generate a single fountain chunk
    pub fn generate_chunk(&mut self) -> FountainChunk {
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
        .min(self.blocks.len());

        // Select indices using the same RNG instance (no reseeding)
        let indices = select_indices_with_rng(&mut rng, degree, self.blocks.len());

        // XOR selected blocks
        let block_refs: Vec<&[u8]> = indices.iter().map(|&i| self.blocks[i].as_slice()).collect();
        let data = xor_blocks(&block_refs);

        FountainChunk::new(seed, degree, indices, data)
    }

    /// Generate multiple chunks at once
    pub fn generate_chunks(&mut self, count: usize) -> Vec<FountainChunk> {
        (0..count).map(|_| self.generate_chunk()).collect()
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
            None,
        );

        let chunk = encoder.generate_chunk();
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
            None,
        );

        let mut encoder2 = FountainEncoder::new(
            data,
            "test.dat".to_string(),
            "application/octet-stream".to_string(),
            0.0,
            options,
            None,
        );

        let chunk1 = encoder1.generate_chunk();
        let chunk2 = encoder2.generate_chunk();

        // Chunks with same seed should be identical
        assert_eq!(chunk1.seed, chunk2.seed);
        assert_eq!(chunk1.degree, chunk2.degree);
        assert_eq!(chunk1.indices, chunk2.indices);
        assert_eq!(chunk1.data, chunk2.data);
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
            Some(0), // seed_offset = 0 for testing
        );

        // Test vectors from JS implementation
        let test_vectors = vec![
            (0, 3, vec![5, 7, 8]),
            (1, 2, vec![3, 9]),
            (42, 2, vec![7, 9]),
            (123, 2, vec![1, 3]),
            (9999, 5, vec![0, 3, 4, 5, 7]),
        ];

        for (seed, expected_degree, expected_indices) in test_vectors {
            // Generate chunk
            encoder.current_seed = seed;
            let chunk = encoder.generate_chunk();

            // Validate seed
            assert_eq!(
                chunk.seed, seed,
                "Seed mismatch for test seed {}",
                seed
            );

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
}
