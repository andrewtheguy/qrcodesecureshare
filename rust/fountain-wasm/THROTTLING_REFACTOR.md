# Throttling Refactor Summary

## Problem
The original implementation had a fundamental flaw: time-based throttling in JavaScript allowed millions of chunks to be received and processed by Rust within a 500ms window, causing memory issues.

## Solution
Refactored throttling from time-based JavaScript logic to chunk-count-based Rust logic.

## Changes

### Rust (`decoder.rs`)

#### Added Fields to `FountainDecoder`
```rust
pending_chunks: Vec<DecodingChunk>,      // Queue for pending chunks
decode_throttle_count: usize,            // Threshold (default: 10)
chunks_since_last_decode: usize,         // Counter
```

#### New Methods

1. **`process_pending_chunks()`** (private)
   - Processes all queued chunks in batch
   - Runs belief propagation once per batch
   - Returns number of newly decoded blocks

2. **`flush_pending_chunks()`** (public)
   - Forces processing of all pending chunks
   - Resets throttle counter
   - Returns number of blocks decoded
   - **Use cases:**
     - Transmission complete, need to process remaining chunks
     - Check for completion without waiting for threshold
     - Ensure all chunks processed before status check

3. **`get_pending_chunk_count()`** (public)
   - Returns number of chunks waiting in queue

4. **`set_decode_throttle_count(count: usize)`** (public)
   - Configure throttle threshold
   - Lower = more frequent decodes (more CPU, faster updates)
   - Higher = fewer decodes (less CPU, slower updates)

5. **`get_decode_throttle_count()`** (public)
   - Returns current throttle threshold

#### Modified `process_chunk_with_validation()`
- Queues non-duplicate chunks instead of processing immediately
- Only triggers decode when `chunks_since_last_decode >= decode_throttle_count`
- Resets counter after each decode
- **Prevents memory buildup from millions of unprocessed chunks**

### WASM Bindings (`lib.rs`)

Exposed new methods through WASM:
- `flushPendingChunks()` → `flush_pending_chunks()`
- `getPendingChunkCount()` → `get_pending_chunk_count()`
- `setDecodeThrottleCount(count)` → `set_decode_throttle_count(count)`
- `getDecodeThrottleCount()` → `get_decode_throttle_count()`

### Worker (`fountainDecoder.worker.ts`)

**Removed:**
- `nonDuplicateChunksSinceLastDecode` variable
- `lastDecodedBlockCount` variable
- `DECODE_THROTTLE_CHUNK_COUNT` constant
- All time-based throttling logic
- Complex conditional logic for `shouldAttemptDecode`

**Simplified:**
- Chunk processing now just calls Rust and gets current state
- No more JavaScript throttling logic
- All decoding orchestration happens in Rust

## Benefits

✅ **Prevents memory issues** - Limits processing to N chunks at a time
✅ **Better performance** - Batch processing is more efficient
✅ **Cleaner code** - All decoding logic centralized in Rust
✅ **Configurable** - Throttle threshold can be tuned per use case
✅ **Force flush** - Can process pending chunks on demand
✅ **All tests pass** - 175 Rust tests confirm correctness

## Default Configuration

- **Throttle threshold:** 10 chunks
- **Behavior:** Process every 10 non-duplicate chunks
- **Can be changed:** Use `setDecodeThrottleCount(n)` to adjust

## Example Usage

```typescript
// Initialize decoder
const decoder = await FountainDecoder.create(metadata, partBasedMode, partSize);

// Optional: Adjust throttle (default is 10)
decoder.wasm.setDecodeThrottleCount(20); // Process every 20 chunks

// Process chunks - automatically throttled
for (const chunk of chunks) {
  const result = decoder.wasm.processChunkWithValidation(chunk, chunkKey);
  // Rust handles throttling internally
}

// Force process remaining chunks when done
const blocksDecoded = decoder.wasm.flushPendingChunks();

// Check pending chunks
const pending = decoder.wasm.getPendingChunkCount();
console.log(`${pending} chunks still pending`);
```

## Migration Notes

For QR code use case: **No changes needed** - throttling happens automatically in Rust.

For other use cases (streaming, network protocols):
- Use `flushPendingChunks()` when transmission completes
- Check `getPendingChunkCount()` to monitor queue size
- Adjust `setDecodeThrottleCount()` if needed for performance tuning
