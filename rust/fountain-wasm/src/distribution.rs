use rand::Rng;

/// Build a robust soliton distribution for fountain codes
/// Returns a vector of probabilities for each degree (index 0 = degree 1)
pub fn build_robust_soliton(k: usize, c: f64, delta: f64, max_degree: usize) -> Vec<f64> {
    // Calculate spike location
    let r_val = c * ((k as f64) / delta).ln() * (k as f64).sqrt();
    let spike_loc = (k as f64 / r_val).floor() as usize;

    let mut rho = vec![0.0; max_degree];
    let mut tau = vec![0.0; max_degree];

    // Build ideal soliton (rho)
    if max_degree >= 1 {
        rho[0] = 1.0 / k as f64; // degree 1
    }
    for d in 2..=max_degree.min(k) {
        rho[d - 1] = 1.0 / (d * (d - 1)) as f64;
    }

    // Build robust component (tau)
    for d in 1..spike_loc.min(max_degree) {
        tau[d - 1] = r_val / (d * k) as f64;
    }
    if spike_loc <= max_degree {
        tau[spike_loc - 1] = r_val * (r_val / delta).ln() / k as f64;
    }

    // Combine and normalize
    let mut mu: Vec<f64> = rho
        .iter()
        .zip(tau.iter())
        .map(|(r, t)| r + t)
        .collect();

    let sum: f64 = mu.iter().sum();
    if sum > 0.0 {
        for p in mu.iter_mut() {
            *p /= sum;
        }
    }

    mu
}

/// Sample a degree from the distribution with doping for low degrees
pub fn sample_degree_with_doping<R: Rng>(
    rng: &mut R,
    distribution: &[f64],
    degree1_rate: f64,
    low_degree_rate: f64,
) -> usize {
    let roll = rng.gen::<f64>();

    // Force degree 1 with probability degree1_rate
    if roll < degree1_rate {
        return 1;
    }

    // Force degree 2-3 with probability low_degree_rate (favor degree 2)
    if roll < degree1_rate + low_degree_rate {
        if distribution.len() >= 2 {
            return if rng.gen::<f64>() < 0.6 { 2 } else { 3 };
        }
        return 2;
    }

    // Sample from robust soliton
    sample_from_distribution(rng, distribution)
}

/// Sample from a discrete probability distribution
fn sample_from_distribution<R: Rng>(rng: &mut R, distribution: &[f64]) -> usize {
    let roll = rng.gen::<f64>();
    let mut cumulative = 0.0;

    for (i, &prob) in distribution.iter().enumerate() {
        cumulative += prob;
        if roll < cumulative {
            return i + 1; // degree is 1-indexed
        }
    }

    // Fallback to last degree if we somehow exceed cumulative
    distribution.len()
}

/// Calculate adaptive max degree based on block count and QR capacity
pub fn calculate_max_degree(k: usize, max_qr_data_size: usize, block_size: usize) -> usize {
    // Hard ceiling based on QR capacity
    let qr_max = max_qr_data_size / block_size;

    // Adaptive ceiling based on k
    let adaptive_max = ((2.5 * (k as f64).sqrt()).round() as usize).clamp(8, 40);

    // Return the minimum of the two
    qr_max.min(adaptive_max).min(k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;

    #[test]
    fn test_build_robust_soliton() {
        let dist = build_robust_soliton(100, 0.2, 0.01, 20);
        assert_eq!(dist.len(), 20);

        // Check that it sums to approximately 1.0
        let sum: f64 = dist.iter().sum();
        assert!((sum - 1.0).abs() < 0.001);

        // Check that probabilities are non-negative
        assert!(dist.iter().all(|&p| p >= 0.0));
    }

    #[test]
    fn test_sample_degree() {
        let dist = build_robust_soliton(100, 0.2, 0.01, 20);
        let mut rng = ChaCha8Rng::seed_from_u64(42);

        for _ in 0..100 {
            let degree = sample_degree_with_doping(&mut rng, &dist, 0.08, 0.18);
            assert!(degree >= 1 && degree <= 20);
        }
    }

    #[test]
    fn test_calculate_max_degree() {
        // Small k should give degree 8
        assert_eq!(calculate_max_degree(10, 1000, 100), 8);

        // Large k should be capped at 40
        assert_eq!(calculate_max_degree(1000, 10000, 100), 40);

        // QR capacity should limit
        assert_eq!(calculate_max_degree(100, 500, 100), 5);
    }
}
