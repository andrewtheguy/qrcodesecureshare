use rand::RngCore;
use std::collections::HashSet;
use std::ops::Range;

/// Linear Congruential Generator (LCG) that matches the TypeScript SeededRandom implementation
/// Uses the same constants: multiplier=9301, increment=49297, modulus=233280
pub struct LcgRandom {
    state: u32,
}

impl LcgRandom {
    /// Create a new LCG with the given seed
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Internal method to advance the state
    /// Implements: state = (state * 9301 + 49297) % 233280
    fn advance_state(&mut self) -> u32 {
        // Use u64 math to match the JavaScript implementation exactly – JS numbers stay
        // precise for these ranges, while u32 wrapping would distort the sequence.
        let next = ((self.state as u64) * 9301 + 49297) % 233_280;
        self.state = next as u32;
        self.state
    }

    /// Generate the next random number between 0.0 and 1.0
    /// Returns: state / 233280.0
    pub fn next(&mut self) -> f64 {
        self.advance_state() as f64 / 233280.0
    }

    /// Generate a random value in the given range [start, end)
    ///
    /// # Panics
    /// Panics if range.start >= range.end (empty or reversed range)
    pub fn gen_range(&mut self, range: Range<usize>) -> usize {
        if range.start >= range.end {
            panic!(
                "gen_range: invalid range [start={}, end={}), start must be less than end",
                range.start, range.end
            );
        }

        let range_len = range.end - range.start;

        // For better precision with large ranges, use integer arithmetic
        // Generate a value in [0, range_len) using unbiased scaling
        let random_int = self.advance_state() as usize;
        let scaled = random_int % range_len;

        range.start + scaled
    }
}

// Implement the RngCore trait for LcgRandom so it can be used with generic code
impl RngCore for LcgRandom {
    fn next_u32(&mut self) -> u32 {
        // Use the shared advance_state method
        self.advance_state()
    }

    fn next_u64(&mut self) -> u64 {
        // Combine two u32 values to create a u64
        let high = self.next_u32() as u64;
        let low = self.next_u32() as u64;
        (high << 32) | low
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // Fill buffer with random bytes
        // Each chunk is at most 4 bytes, so we can safely copy from the 4-byte array
        for chunk in dest.chunks_mut(4) {
            let val = self.next_u32();
            let bytes = val.to_le_bytes();
            // Copy only the needed prefix of bytes into this chunk
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

/// Select random unique indices using a provided LcgRandom RNG
/// Returns a sorted vector of unique indices
/// This function reuses the RNG state without reseeding
///
/// # Panics
/// Panics if degree > max_index, as it's impossible to select more unique indices than available
pub fn select_indices_with_rng(rng: &mut LcgRandom, degree: usize, max_index: usize) -> Vec<usize> {
    if degree > max_index {
        panic!(
            "select_indices_with_rng: degree ({}) cannot exceed max_index ({})",
            degree, max_index
        );
    }

    let mut selected = HashSet::new();

    // Keep selecting until we have enough unique indices
    while selected.len() < degree {
        let index = rng.gen_range(0..max_index);
        selected.insert(index);
    }

    // Sort indices for consistent ordering
    let mut indices: Vec<usize> = selected.into_iter().collect();
    indices.sort_unstable();
    indices
}

/// Create a seeded RNG from a u32 seed
pub fn create_rng(seed: u32) -> LcgRandom {
    LcgRandom::new(seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lcg_deterministic() {
        // Test that two LCG instances with the same seed produce identical sequences
        let mut rng1 = LcgRandom::new(12345);
        let mut rng2 = LcgRandom::new(12345);

        for _ in 0..100 {
            let val1 = rng1.next();
            let val2 = rng2.next();
            assert_eq!(val1, val2);
        }
    }

    #[test]
    fn test_lcg_matches_typescript() {
        // Test that the LCG produces the same values as the TypeScript implementation
        // TypeScript SeededRandom with seed=12345 produces:
        // First call: state=96382, value=0.4131601508916324
        // Second call: state=3239, value=0.01388460219478738
        // Third call: state=82116, value=0.3520061728395062

        let mut rng = LcgRandom::new(12345);

        // First value
        let val1 = rng.next();
        let expected_state1 = 96382;
        let expected_val1 = 0.4131601508916324;
        assert_eq!(rng.state, expected_state1);
        assert!((val1 - expected_val1).abs() < 1e-10);

        // Second value
        let val2 = rng.next();
        let expected_state2 = 3239;
        let expected_val2 = 0.01388460219478738;
        assert_eq!(rng.state, expected_state2);
        assert!((val2 - expected_val2).abs() < 1e-10);

        // Third value
        let val3 = rng.next();
        let expected_state3 = 82116;
        let expected_val3 = 0.3520061728395062;
        assert_eq!(rng.state, expected_state3);
        assert!((val3 - expected_val3).abs() < 1e-10);
    }

    #[test]
    fn test_lcg_matches_typescript_large_seed() {
        // Ensure large seeds (e.g. timestamp-based) match JS behavior and do not overflow
        let mut rng = LcgRandom::new(1_700_000_000);

        let val1 = rng.next();
        assert_eq!(rng.state, 78_417);
        assert!((val1 - 0.336_149_691_358_024_7).abs() < 1e-12);

        let val2 = rng.next();
        assert_eq!(rng.state, 172_534);
        assert!((val2 - 0.739_600_480_109_739_3).abs() < 1e-12);

        let val3 = rng.next();
        assert_eq!(rng.state, 54_911);
        assert!((val3 - 0.235_386_659_807_956_12).abs() < 1e-12);
    }

    #[test]
    fn test_lcg_gen_range() {
        // Test that gen_range produces values in the expected range
        let mut rng = LcgRandom::new(42);

        for _ in 0..100 {
            let val = rng.gen_range(0..10);
            assert!(val < 10);
        }

        // Test with a different range
        let mut rng2 = LcgRandom::new(999);
        for _ in 0..100 {
            let val = rng2.gen_range(50..100);
            assert!(val >= 50 && val < 100);
        }
    }

    #[test]
    fn test_select_indices_with_rng_unique() {
        let mut rng = LcgRandom::new(42);
        let indices = select_indices_with_rng(&mut rng, 5, 100);
        assert_eq!(indices.len(), 5);

        // Check uniqueness
        let unique: HashSet<_> = indices.iter().collect();
        assert_eq!(unique.len(), 5);

        // Check all indices are in range
        assert!(indices.iter().all(|&i| i < 100));
    }

    #[test]
    fn test_select_indices_with_rng_reuses_state() {
        // Test that the RNG state is preserved across calls
        let mut rng1 = LcgRandom::new(42);
        let mut rng2 = LcgRandom::new(42);

        // Use the first RNG for degree sampling and index selection
        let _degree1 = rng1.gen_range(1..10);
        let indices1 = select_indices_with_rng(&mut rng1, 5, 100);

        // With the old approach (reseeding), this would give the same indices
        // but with the new approach, the RNG state is preserved
        let _degree2 = rng2.gen_range(1..10);
        let indices2 = select_indices_with_rng(&mut rng2, 5, 100);

        // Should be identical because both RNGs had same initial state
        assert_eq!(indices1, indices2);
    }

    #[test]
    fn test_select_indices_with_rng_deterministic() {
        // Test multiple times with the same seed to ensure determinism
        let mut rng1 = LcgRandom::new(123);
        let indices1 = select_indices_with_rng(&mut rng1, 10, 50);

        let mut rng2 = LcgRandom::new(123);
        let indices2 = select_indices_with_rng(&mut rng2, 10, 50);

        let mut rng3 = LcgRandom::new(123);
        let indices3 = select_indices_with_rng(&mut rng3, 10, 50);

        assert_eq!(indices1, indices2);
        assert_eq!(indices2, indices3);
    }

    #[test]
    fn test_select_indices_with_rng_different_seeds() {
        let mut rng1 = LcgRandom::new(1);
        let indices1 = select_indices_with_rng(&mut rng1, 10, 50);

        let mut rng2 = LcgRandom::new(2);
        let indices2 = select_indices_with_rng(&mut rng2, 10, 50);

        assert_ne!(indices1, indices2);
    }

    #[test]
    fn test_select_indices_with_rng_sorted() {
        let mut rng = LcgRandom::new(999);
        let indices = select_indices_with_rng(&mut rng, 8, 100);
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        assert_eq!(indices, sorted);
    }

    #[test]
    fn test_create_rng_deterministic() {
        let mut rng1 = create_rng(42);
        let mut rng2 = create_rng(42);

        let val1 = rng1.next();
        let val2 = rng2.next();
        assert_eq!(val1, val2);
    }

    #[test]
    #[should_panic(expected = "gen_range: invalid range [start=10, end=10), start must be less than end")]
    fn test_gen_range_empty_range_panics() {
        let mut rng = LcgRandom::new(42);
        // This should panic because start >= end (empty range)
        rng.gen_range(10..10);
    }

    #[test]
    #[should_panic(expected = "select_indices_with_rng: degree (10) cannot exceed max_index (5)")]
    fn test_select_indices_degree_exceeds_max_index_panics() {
        let mut rng = LcgRandom::new(42);
        // This should panic because degree > max_index
        select_indices_with_rng(&mut rng, 10, 5);
    }
}
