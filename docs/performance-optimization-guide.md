# Performance Optimization Guide - QR Generation Bottleneck

## Executive Summary

This guide documents the QR generation optimization strategy implemented to address the primary performance bottleneck in the fountain QR transfer system. Through detailed analysis, QR code generation was identified as consuming 99.8% of transfer time, while fountain encoding accounted for only 0.2%. This guide outlines five progressive optimizations providing 2-10x speedup with significantly less effort than alternative approaches.

## Performance Baseline

- **Current transfer speed**: ~2 FPS, ~270 seconds for 200KB file
- **Bottleneck breakdown**: QR generation ~500ms/chunk, fountain encoding ~1ms/chunk
- **Profiling methodology**: Code analysis and timing measurements

## Option 5: Increase FPS (Quick Win - 30 minutes, 2x speedup)

**Effort**: 30 minutes
**Speedup**: 2x
**Implementation**: Change default FPS from 2 to 4
**Files**: `FountainQRSender.tsx` (state initialization, slider default)
**Testing**: Verify QR generation keeps up, monitor skipped chunks
**Rollback**: Revert to 2 FPS or try 3 FPS

**Expected Result**: Transfer time cut in half (e.g., 270s → 135s for 200KB file) with no code complexity increase.

## Option 1: Optimize QR Settings (Easy - 1-2 hours, 20-30% speedup)

**Effort**: 1-2 hours
**Speedup**: 20-30%
**Implementation**: Lower error correction to 'L', reduce margin, optimize PNG settings
**Files**: `FountainQRSender.tsx` (QRCode.toDataURL options)
**Trade-offs**: Slightly less robust to damage (acceptable for screen display)
**Testing**: Verify scanning reliability, check skipped chunks

**Expected Result**: 20-30% faster QR generation, combined with Option 5 gives ~2.5x total speedup.

## Option 2: Pre-generate Chunks (Medium - 1 day, 50% speedup)

**Effort**: 1 day
**Speedup**: 50%
**Implementation**: Buffer 5 chunks, generate in background, display from buffer
**Files**: `FountainQRSender.tsx` (new state, background generation effect, modified display loop)
**Trade-offs**: More memory (~2-5MB for buffer), more complex state
**Testing**: Verify buffer stays full, handle state changes correctly

**Expected Result**: Effective 50% speedup because generation happens in parallel with display. Combined with Options 5+1 gives ~4x total speedup.

## Option 3: WebWorker (Medium - 2-3 days, 2x speedup)

**Effort**: 2-3 days
**Speedup**: 2x
**Implementation**: Create worker for QR generation, offload from main thread
**Files**: `qrGenerator.worker.ts` (new), `FountainQRSender.tsx` (worker integration)
**Trade-offs**: More complex architecture, worker initialization overhead
**Testing**: Verify worker communication, handle errors, test parallel generation

**Expected Result**: 2x speedup by offloading QR generation from main thread. UI remains responsive during generation. Combined with Options 5+1+2 gives ~5-6x total speedup.

## Option 4: Canvas Rendering (Hard - 3-5 days, 3-5x speedup)

**Effort**: 3-5 days
**Speedup**: 3-5x
**Implementation**: Replace data URLs with direct canvas rendering
**Files**: `FountainQRSender.tsx` (canvas ref, toCanvas instead of toDataURL, render updates)
**Trade-offs**: More complex rendering, canvas API, retina handling
**Testing**: Verify rendering quality, test on various devices/DPI

**Expected Result**: 3-5x speedup by eliminating base64 encoding and data URL overhead. Combined with Options 5+1+2+3 gives ~8-10x total speedup.

## Combined Speedup Calculation

- **Options 5+1**: ~2.5x speedup (4 FPS × 1.25 faster generation)
- **Options 5+1+2**: ~4x speedup (effective 6 FPS with buffering)
- **Options 5+1+2+3**: ~5-6x speedup (parallel generation)
- **Options 5+1+2+3+4**: ~8-10x speedup (canvas rendering)
- **Example**: 200KB file: 270s → 108s → 67s → 54s → 27-34s

## Implementation Roadmap

- **Week 1**: Options 5+1 (quick wins, 2.5x speedup, 2-3 hours total)
- **Week 2**: Option 2 if needed (4x total speedup, +1 day)
- **Week 3-4**: Options 3+4 if maximum speed required (8-10x total speedup, +5-8 days)

## Benchmarking and Validation

Add performance.now() timing around QR generation:

```typescript
const qrStartTime = performance.now()
// QR generation code
const qrEndTime = performance.now()
console.log('QR generation time:', qrEndTime - qrStartTime, 'ms')
```

Track metrics: chunks/sec, MB/s, time per chunk, skipped chunks. Compare before/after times for each optimization. Remove logging after validation.

## Why Not Wirehair-wasm?

- Wirehair would only provide 5.5% speedup (lower overhead)
- Requires 2-3 weeks effort to reimplement features
- Doesn't address the actual bottleneck (QR generation)
- QR optimizations provide 2-10x speedup with less effort
- Better ROI: hours/days vs weeks for better results

## Future Optimizations

- Hardware acceleration (WebGPU for QR generation)
- Alternative visual encoding (color QR, animated QR, custom encoding)
- Native mobile apps (faster QR generation and scanning)
- Hybrid approach (WebRTC when available, QR as fallback)
- Better fountain codes (wirehair-wasm) after QR is optimized

## Troubleshooting

- **High skipped chunks**: Reduce block size or optimize QR settings first
- **Buffer draining**: Increase buffer size or optimize generation speed
- **Worker errors**: Check browser support, fall back to main thread
- **Canvas rendering issues**: Check DPI handling, test on various devices

## References

- QRCode library docs: https://github.com/soldair/node-qrcode
- Web Workers API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- Canvas API: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
- Performance API: https://developer.mozilla.org/en-US/docs/Web/API/Performance
- Related files: `FountainQRSender.tsx`, `FountainQRReceiver.tsx`, `fountainCode.ts`