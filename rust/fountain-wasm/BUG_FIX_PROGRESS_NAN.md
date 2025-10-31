# Bug Fix: NaN% Progress and Missing Block Stats

## Problem

After the worker refactoring, the receiver UI was showing:
- NaN% progress
- No block statistics
- Only chunk count displayed
- Appeared to be scanning but not making progress

## Root Cause

Two related issues were causing this problem:

### Issue 1: Duplicate Chunks Not Sending Progress Data

In `src/workers/fountainDecoder.worker.ts` (line 134), when handling duplicate chunks, the worker only sent minimal data:

```typescript
// OLD CODE - Missing progress data
if (result.type === 'duplicate') {
    self.postMessage({ type: 'chunkProcessed', id, duplicate: true, seed: result.seed });
    break;
}
```

The Rust `processBinaryChunk()` method returns **all progress data** even for duplicate chunks (current decoded blocks, progress, etc.), but the worker wasn't forwarding it.

### Issue 2: Receiver Early Return for Duplicates

In `src/components/fountain_qr/FountainQRReceiver.tsx` (line 118-120), the receiver had an early return for duplicate chunks:

```typescript
// OLD CODE - Early return prevented state updates
if (duplicate) {
    return  // <-- BUG: Never updates state!
}
setDecodedBlocks(decodedBlockCount)  // Never reached for duplicates
```

This meant:
- If many duplicate chunks came in (common in QR scanning), state never updated
- `decodedBlocks` remained 0 → NaN% when calculating progress
- UI froze showing no progress

## Solution

### Fix 1: Worker Sends Full Progress for Duplicates

```typescript
// NEW CODE - Send all progress data even for duplicates
if (result.type === 'duplicate') {
    self.postMessage({
        type: 'chunkProcessed',
        id,
        duplicate: true,
        seed: result.seed,
        decodedBlockCount: result.decodedBlockCount,
        overallProgress: result.overallProgress,
        partProgress: result.partProgress,
        isComplete: result.isComplete,
        decodedBlockIndices: result.decodedBlockIndices,
        currentPartDecodedBlocks: result.currentPartDecodedBlocks,
        currentPartTotalBlocks: result.currentPartTotalBlocks,
        currentPartIndex: result.currentPartIndex,
        totalParts: result.totalParts
    });
    break;
}
```

### Fix 2: Receiver Updates State Before Checking Duplicate

```typescript
// NEW CODE - Always update progress first
const { duplicate, decodedBlockCount, ... } = data

// Always update progress, even for duplicates
setDecodedBlocks(decodedBlockCount)
decodedBlockIndicesRef.current = decodedBlockIndices

// Update part-specific state
if (partIndex !== undefined && numParts !== undefined) {
    setCurrentPartIndex(partIndex)
    setTotalParts(numParts)
}
if (partDecodedBlocks !== undefined && partTotalBlocks !== undefined) {
    setCurrentPartDecodedBlocks(partDecodedBlocks)
    setCurrentPartTotalBlocks(partTotalBlocks)
}

// Now skip further processing for duplicates
if (duplicate) {
    break  // Skip part completion logic, but state is updated!
}
```

## Why This Matters

In QR code scanning:
1. Camera captures frames rapidly (30-60 fps)
2. Many frames show the **same QR code** → duplicate chunks
3. If duplicates don't update UI state → frozen progress display
4. User sees "NaN%" and thinks transfer is broken

Now:
- Every chunk (duplicate or not) updates the UI
- Progress always shows current state
- User sees live feedback even during duplicate bursts

## Files Changed

1. ✅ `src/workers/fountainDecoder.worker.ts` - Send full progress for duplicates
2. ✅ `src/components/fountain_qr/FountainQRReceiver.tsx` - Update state before duplicate check

## Testing

After fix:
- ✅ Progress shows correct percentage
- ✅ Block statistics display properly
- ✅ Decoded block count updates in real-time
- ✅ UI responsive even with many duplicates
- ✅ Part-based mode progress works correctly

## Related

This bug was introduced during the worker refactoring (moving all backend logic to Rust). The refactoring itself was correct - this was an integration issue where duplicate chunks weren't being handled properly in the new flow.
