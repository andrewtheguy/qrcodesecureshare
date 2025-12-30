/**
 * Generate test vectors from the TypeScript implementation
 * Run with: node scripts/generate_test_vectors.js
 */

class SeededRandom {
    constructor(seed) {
        this.seed = seed;
    }

    next() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
}

function robustSolitonDistribution(k, c, delta) {
    const R = c * Math.log(k / delta) * Math.sqrt(k);
    const probs = new Array(k).fill(0);

    // Ideal Soliton
    probs[0] = 1 / k;
    for (let i = 2; i <= k; i++) probs[i - 1] = 1 / (i * (i - 1));

    // Tau (robust component)
    const tau = new Array(k).fill(0);
    const threshold = Math.floor(k / R);
    for (let i = 1; i < threshold; i++) tau[i - 1] = R / (i * k);
    if (threshold - 1 >= 0 && threshold - 1 < k) {
        tau[threshold - 1] = R * Math.log(R / delta) / k;
    }

    const sumBase = probs.reduce((s, v) => s + v, 0);
    const sumTau = tau.reduce((s, v) => s + v, 0);
    const beta = sumBase + sumTau;
    for (let i = 0; i < k; i++) probs[i] = (probs[i] + tau[i]) / beta;
    return probs;
}

function buildDegreeDistribution(k, c, delta, maxDegree) {
    const base = robustSolitonDistribution(k, c, delta);
    const limit = Math.min(maxDegree, k);
    const truncated = base.slice(0, limit);
    const sum = truncated.reduce((s, v) => s + v, 0);
    for (let i = 0; i < truncated.length; i++) truncated[i] /= sum;
    return truncated;
}

function sampleDegree(rng, dist, opts) {
    const r = rng.next();
    if (r < opts.degree1Rate) return 1;
    if (r < opts.degree1Rate + opts.lowDegreeRate) {
        // degree 2 or 3 (favor 2 slightly)
        return rng.next() < 0.6 ? 2 : 3;
    }
    // sample from truncated robust soliton distribution
    const r2 = rng.next();
    let cumulative = 0;
    for (let i = 0; i < dist.length; i++) {
        cumulative += dist[i];
        if (r2 <= cumulative) return i + 1;
    }
    return dist.length;
}

function selectIndices(rng, degree, maxIndex) {
    const indices = [];
    const selected = new Set();

    while (selected.size < degree) {
        const idx = Math.floor(rng.next() * maxIndex);
        if (!selected.has(idx)) {
            selected.add(idx);
            indices.push(idx);
        }
    }

    return indices.sort((a, b) => a - b);
}

// Test parameters matching Rust defaults
const k = 10; // 10 blocks
const blockSize = 400;
const c = 0.2;
const delta = 0.01;
const maxDegree = 8; // min(40, max(8, round(2.5 * sqrt(10)))) = 8
const degree1Rate = 0.08;
const lowDegreeRate = 0.18;

const dist = buildDegreeDistribution(k, c, delta, maxDegree);
const samplerOpts = { degree1Rate, lowDegreeRate };

console.log("// Test vectors for Rust integration test");
console.log(`// Parameters: k=10, blockSize=${blockSize}, c=0.2, delta=0.01, maxDegree=8`);
console.log("// degree1Rate=0.08, lowDegreeRate=0.18");
console.log("");

// Generate test vectors for several seeds
const testSeeds = [0, 1, 42, 123, 9999];

for (const seed of testSeeds) {
    const rng = new SeededRandom(seed);
    const degree = sampleDegree(rng, dist, samplerOpts);
    const indices = selectIndices(rng, degree, k);

    console.log(`Seed ${seed}: degree=${degree}, indices=[${indices.join(', ')}]`);
}
