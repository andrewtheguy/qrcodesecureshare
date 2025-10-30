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
/// Formula mirrors sender packing: degree <= floor((maxQRDataSize - fixedOverhead - partOverhead - blockSize) / 2)
/// where fixedOverhead = 10 bytes (magic + seed + degree + numIndices + checksum)
/// and partOverhead = 0 or 8 bytes (currentPart + totalParts + partChecksum)
pub fn calculate_max_degree(
    k: usize,
    max_qr_data_size: usize,
    block_size: usize,
    fixed_overhead: usize,
    part_overhead: usize,
) -> usize {
    // Hard ceiling based on QR capacity constraints
    // Total size = fixed_overhead + part_overhead + (degree * 2) + block_size
    // Solve for degree: degree <= (max_qr_data_size - fixed_overhead - part_overhead - block_size) / 2
    let available_space = max_qr_data_size.saturating_sub(fixed_overhead + part_overhead + block_size);
    let qr_max = available_space / 2; // Each index costs 2 bytes

    // Adaptive ceiling based on k
    let adaptive_max = ((2.5 * (k as f64).sqrt()).round() as usize).clamp(8, 40);

    // Return the minimum of the three constraints
    qr_max.min(adaptive_max).min(k).max(1) // Ensure at least degree 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::LcgRandom;

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
        let mut rng = LcgRandom::new(42);

        for _ in 0..100 {
            let degree = sample_degree_with_doping(&mut rng, &dist, 0.08, 0.18);
            assert!(degree >= 1 && degree <= 20);
        }
    }

    #[test]
    fn test_calculate_max_degree() {
        let fixed_overhead = 10; // magic(2) + seed(2) + degree(1) + numIndices(1) + checksum(4)
        let part_overhead = 0; // non-part mode

        // Small k should give degree 8
        assert_eq!(calculate_max_degree(10, 1000, 100, fixed_overhead, part_overhead), 8);

        // Large k should be capped at 40
        assert_eq!(calculate_max_degree(1000, 10000, 100, fixed_overhead, part_overhead), 40);

        // QR capacity should limit
        // Available space: 500 - 10 - 0 - 100 = 390, degree = 390 / 2 = 195
        // But adaptive max for k=100 is ~25, so result should be 25
        assert!(calculate_max_degree(100, 500, 100, fixed_overhead, part_overhead) <= 100);
    }

    #[test]
    fn test_calculate_max_degree_with_part_overhead() {
        let fixed_overhead = 10;
        let part_overhead = 8; // part-based mode

        // With part overhead, available space is reduced
        // maxQR=1000, blockSize=400, fixed=10, part=8
        // Available: 1000 - 10 - 8 - 400 = 582, degree = 582 / 2 = 291
        // For k=100, adaptive ~25, so result should be 25
        let degree = calculate_max_degree(100, 1000, 400, fixed_overhead, part_overhead);
        assert!(degree >= 1 && degree <= 100);

        // Verify formula: degree * 2 + block_size + fixed + part <= maxQR
        let total_size = (degree * 2) + 400 + fixed_overhead + part_overhead;
        assert!(total_size <= 1000, "Generated degree {} produces size {} > 1000", degree, total_size);
    }

    #[test]
    fn test_max_degree_matches_sender_packing() {
        // Simulate actual sender constraints
        let fixed_overhead = 10;
        let part_overhead = 0;
        let block_size = 400;
        let max_qr_size = 2953; // Typical QR code capacity
        let k = 100;

        let degree = calculate_max_degree(k, max_qr_size, block_size, fixed_overhead, part_overhead);

        // Verify the generated degree respects the sender packing formula
        let packed_size = fixed_overhead + part_overhead + (degree * 2) + block_size;
        assert!(
            packed_size <= max_qr_size,
            "Degree {} generates packed size {} which exceeds max QR size {}",
            degree,
            packed_size,
            max_qr_size
        );

        // Calculate what the limits are
        let available_space = max_qr_size.saturating_sub(fixed_overhead + part_overhead + block_size);
        let qr_max = available_space / 2;
        let adaptive_max = ((2.5 * (k as f64).sqrt()).round() as usize).clamp(8, 40);
        let expected_degree = qr_max.min(adaptive_max).min(k).max(1);

        // Verify we got the expected degree
        assert_eq!(
            degree, expected_degree,
            "Degree {} doesn't match expected calculation {}",
            degree, expected_degree
        );

        // Verify degree+1 would either exceed QR capacity OR adaptive limit OR k
        let next_packed_size = fixed_overhead + part_overhead + ((degree + 1) * 2) + block_size;
        assert!(
            next_packed_size > max_qr_size || degree >= adaptive_max || degree >= k,
            "Degree {} is not maximal: degree+1 would fit within constraints",
            degree
        );
    }
}
