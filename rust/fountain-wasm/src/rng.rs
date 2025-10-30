use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::HashSet;

/// Select random unique indices using a seeded RNG
/// Returns a sorted vector of unique indices
pub fn select_indices(seed: u32, degree: usize, max_index: usize) -> Vec<usize> {
    let mut rng = ChaCha8Rng::seed_from_u64(seed as u64);
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
pub fn create_rng(seed: u32) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_indices_unique() {
        let indices = select_indices(42, 5, 100);
        assert_eq!(indices.len(), 5);

        // Check uniqueness
        let unique: HashSet<_> = indices.iter().collect();
        assert_eq!(unique.len(), 5);

        // Check all indices are in range
        assert!(indices.iter().all(|&i| i < 100));
    }

    #[test]
    fn test_select_indices_deterministic() {
        let indices1 = select_indices(123, 10, 50);
        let indices2 = select_indices(123, 10, 50);
        assert_eq!(indices1, indices2);
    }

    #[test]
    fn test_select_indices_different_seeds() {
        let indices1 = select_indices(1, 10, 50);
        let indices2 = select_indices(2, 10, 50);
        assert_ne!(indices1, indices2);
    }

    #[test]
    fn test_select_indices_sorted() {
        let indices = select_indices(999, 8, 100);
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        assert_eq!(indices, sorted);
    }

    #[test]
    fn test_create_rng_deterministic() {
        let mut rng1 = create_rng(42);
        let mut rng2 = create_rng(42);

        let val1: u32 = rng1.gen();
        let val2: u32 = rng2.gen();
        assert_eq!(val1, val2);
    }
}
