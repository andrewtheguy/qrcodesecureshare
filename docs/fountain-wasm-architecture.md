# Fountain-WASM Architecture

High-performance WebAssembly module implementing LT (Luby Transform) fountain codes for reliable data transfer over lossy channels like animated QR codes.

## Overview

Fountain codes are rateless erasure codes that can generate an unlimited stream of encoded chunks from source data. The receiver can reconstruct the original data from any sufficiently large subset of chunks, regardless of which specific chunks are received.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Encoder Flow                              │
├─────────────────────────────────────────────────────────────────┤
│  Source Data → Split into Blocks → Generate Chunks → QR Codes   │
│                                                                  │
│  [File Data]  →  [Block 0]  →  Chunk(seed=0, indices=[0,2])     │
│               →  [Block 1]  →  Chunk(seed=1, indices=[1])       │
│               →  [Block 2]  →  Chunk(seed=2, indices=[0,1,2])   │
│               →  ...        →  ... (infinite stream)            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        Decoder Flow                              │
├─────────────────────────────────────────────────────────────────┤
│  QR Scan → Parse Chunk → Belief Propagation → Reconstruct       │
│                                                                  │
│  Chunk(indices=[1])     → Decode Block 1 directly               │
│  Chunk(indices=[0,1])   → XOR with Block 1 → Decode Block 0     │
│  Chunk(indices=[0,1,2]) → XOR with 0,1 → Decode Block 2         │
└─────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
rust/fountain-wasm/src/
├── lib.rs           # WASM bindings and public API
├── encoder.rs       # FountainEncoder - chunk generation
├── decoder.rs       # FountainDecoder - belief propagation decoding
├── distribution.rs  # Robust Soliton distribution for degree sampling
├── parser.rs        # Binary chunk parsing and validation
├── types.rs         # Core data structures (FountainChunk, FountainMetadata)
├── rng.rs           # Deterministic LCG random number generator
├── checksum.rs      # CRC32 checksums for data integrity
└── xor.rs           # Optimized XOR operations
```

## Core Components

### FountainEncoder (`encoder.rs`)

Generates an infinite stream of encoded chunks from source data.

**Key Features:**
- Splits data into fixed-size blocks (default 400 bytes)
- Uses Robust Soliton distribution for degree sampling
- Deterministic chunk generation via seeded RNG
- Part-based mode for large file streaming

**Chunk Generation Algorithm:**
1. Apply seed offset for session randomization
2. Sample degree using doped Robust Soliton distribution
3. Select `degree` random block indices using LCG
4. XOR selected blocks together to produce chunk data

```rust
pub struct FountainEncoder {
    blocks: Vec<Vec<u8>>,           // Source blocks
    metadata: FountainMetadata,      // File metadata
    degree_distribution: Vec<f64>,   // Probability distribution
    current_seed: u32,               // Chunk generation seed
    seed_offset: u32,                // Session-specific offset
    // Part-based mode fields...
}
```

### FountainDecoder (`decoder.rs`)

Reconstructs original data using belief propagation algorithm.

**Key Features:**
- Processes chunks in any order
- Handles duplicate chunks efficiently
- Supports part-based streaming for large files
- Adaptive throttling for performance optimization

**Belief Propagation Algorithm:**
1. Add incoming chunk to processing queue
2. Remove already-decoded blocks from chunk (XOR reduction)
3. If chunk has degree 1 (singleton), decode the block directly
4. When a block is decoded, propagate to all chunks referencing it
5. Repeat until no more singletons are available

```rust
pub struct FountainDecoder {
    metadata: FountainMetadata,
    decoded_blocks: HashMap<usize, Vec<u8>>,
    chunks: Vec<DecodingChunk>,
    block_to_chunks: HashMap<usize, BTreeSet<usize>>,
    singleton_queue: VecDeque<usize>,
    // Part-based mode and throttling fields...
}
```

### Distribution (`distribution.rs`)

Implements Robust Soliton distribution for optimal degree sampling.

**Formula:**
```
μ(d) = ρ(d) + τ(d)

where:
  ρ(d) = 1/k for d=1, 1/(d(d-1)) for d>1  (Ideal Soliton)
  τ(d) = R/(dk) for d < k/R              (Robust component)
  R = c * ln(k/δ) * sqrt(k)              (Spike location)
```

**Degree Doping:**
- `degree1_rate`: Force degree-1 chunks (default 8%) for faster initial decoding
- `low_degree_rate`: Force degree 2-3 chunks (default 18%) for robustness

### Parser (`parser.rs`)

Parses binary chunk format from QR code data.

**Binary Format:**
```
Offset  Size  Field
──────────────────────────────────
0       2     Magic bytes [0xFF][0xFD]
2       2     Seed (u16, big-endian)
4       1     Degree (u8)
5       1     NumIndices (u8)
6       2*N   Indices (u16 each, big-endian)
...     8     Part metadata (optional):
              - Current part (u16)
              - Total parts (u16)
              - Part checksum (4 bytes)
...     var   Chunk data
-4      4     CRC32 checksum
```

### RNG (`rng.rs`)

Linear Congruential Generator matching TypeScript implementation for cross-platform determinism.

```rust
// LCG formula: state = (state * 9301 + 49297) % 233280
// Output: state / 233280.0 (range [0, 1))

pub struct LcgRandom {
    state: u32,
}
```

**Critical:** Both encoder and decoder must use identical RNG to reproduce the same block selections from a given seed.

### Checksum (`checksum.rs`)

CRC32 checksums using `crc32fast` crate for data integrity verification.

### XOR (`xor.rs`)

Optimized XOR operations using word-sized (usize) processing for performance.

## Part-Based Mode

For large files, data is divided into parts that are encoded and transmitted sequentially.

```
┌──────────────────────────────────────────────────────────────┐
│                    Part-Based Transfer                        │
├──────────────────────────────────────────────────────────────┤
│  File (1.3 MB)                                                │
│    ├── Part 0 (512 KB) → Encode → Transfer → Verify → Clear  │
│    ├── Part 1 (512 KB) → Encode → Transfer → Verify → Clear  │
│    └── Part 2 (276 KB) → Encode → Transfer → Verify → Done   │
└──────────────────────────────────────────────────────────────┘
```

**Memory Optimization:**
- `mark_part_completed()`: Permanently drops source blocks for completed parts
- Allows streaming of files larger than available memory

**Checksums:**
- Each part has a CRC32 checksum
- Receiver validates part data before confirming completion

## WASM API

The `lib.rs` exposes JavaScript-callable functions:

```rust
// Encoder API
#[wasm_bindgen]
pub fn create_encoder(...) -> WasmEncoder;
pub fn generate_chunk(encoder: &mut WasmEncoder) -> JsValue;
pub fn generate_chunks(encoder: &mut WasmEncoder, count: usize) -> JsValue;

// Decoder API
#[wasm_bindgen]
pub fn create_decoder(metadata: JsValue) -> WasmDecoder;
pub fn add_chunk(decoder: &mut WasmDecoder, chunk: JsValue) -> bool;
pub fn is_complete(decoder: &WasmDecoder) -> bool;
pub fn get_data(decoder: &WasmDecoder) -> Vec<u8>;

// Utility API
#[wasm_bindgen]
pub fn parse_binary_chunk(bytes: &[u8], ...) -> JsValue;
pub fn compute_crc32(data: &[u8]) -> String;
```

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Chunk generation | O(degree) | Typically O(1) to O(40) |
| Chunk decoding | O(degree) | Per-chunk processing |
| Belief propagation | O(chunks × avg_degree) | Amortized over all chunks |
| Memory (encoder) | O(data_size) | Or O(part_size) in part mode |
| Memory (decoder) | O(data_size + pending_chunks) | Pending chunks cleared on decode |

## Build Instructions

```bash
cd rust/fountain-wasm

# Development build (faster, larger)
wasm-pack build --target web --dev

# Release build (optimized)
wasm-pack build --target web --release
```

Output: `pkg/` directory with `.wasm` file and JS bindings.

## Configuration Options

### Encoder Options

| Option | Default | Description |
|--------|---------|-------------|
| `block_size` | 400 | Bytes per source block |
| `c` | 0.2 | Robust Soliton constant |
| `delta` | 0.01 | Failure probability |
| `degree1_rate` | 0.08 | Forced degree-1 probability |
| `low_degree_rate` | 0.18 | Forced low-degree probability |
| `max_qr_data_size` | 2953 | QR capacity constraint |
| `fixed_overhead` | 10 | Header bytes per chunk |
| `part_overhead` | 0/8 | Part metadata bytes |

### Decoder Options

| Option | Default | Description |
|--------|---------|-------------|
| `decode_throttle_count` | 10 | Chunks before decode attempt |
| `adaptive_throttle_percentage` | 0.05 | Incremental decode threshold |
| `min_incremental_chunks` | 10 | Minimum chunks for incremental |

## Testing

```bash
cd rust/fountain-wasm
cargo test
```

Key test categories:
- Encoder/decoder round-trip
- Determinism verification
- Part-based mode transitions
- Edge cases (empty data, single block, etc.)
