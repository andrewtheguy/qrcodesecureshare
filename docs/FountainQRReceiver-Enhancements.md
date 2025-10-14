# FountainQRReceiver New Techniques and Enhancements on v0.1.5

## Overview
The `FountainQRReceiver.tsx` component has been significantly enhanced with advanced feedback mechanisms, windowed transfer support, and defragmentation capabilities. These improvements enable more efficient and robust fountain code transfers, especially for larger files.

## Key New Features

### 1. Windowed Transfer Support
- **Purpose**: Enables progressive file transfer by focusing on specific block ranges
- **Configuration**: Controlled via metadata props (`windowEnabled`, `initialWindowBlocks`, `windowExpansionFactor`, `windowTriggerThreshold`, `windowStart`)
- **Benefits**: Reduces memory usage and improves transfer efficiency for large files
- **Implementation**: Tracks `currentWindowStart` and `currentWindowEnd` states, expands window upon feedback acknowledgment

### 2. Advanced Feedback System
- **Multi-Mode Feedback**: Supports both 'statistics' (compact) and 'targeted' (detailed) feedback modes
- **Priority-Based Triggers**: Implements mutually exclusive feedback generation with strict priority ordering:
  1. **Window Saturation** (Highest Priority): Triggers when window decode percentage reaches threshold
  2. **Targeted Mode**: Activates when missing blocks drop below `TARGETED_MODE_MAX_MISSING_BLOCKS`
  3. **Fragmentation Detection** (Lowest Priority): Identifies gaps in decoded blocks for defragmentation

### 3. Defragmentation (Defrag) System
- **Fragmentation Detection**: Analyzes prefix window (first N blocks) for missing contiguous blocks
- **Configurable Parameters**:
  - `DEFRAG_MAX_TARGETS`: Maximum missing blocks to target (default: 10)
  - `DEFRAG_MAX_MISSING_COUNT`: Maximum missing blocks in prefix window (default: 50)
  - `DEFRAG_PREFIX_WINDOW_BLOCKS`: Absolute prefix window size (default: 100)
  - `DEFRAG_PREFIX_WINDOW_RATIO`: Relative prefix window size (default: 0.1)
  - `DEFRAG_MIN_OVERALL_PROGRESS`: Minimum progress required for defrag (default: 0.3)
- **Smart Targeting**: Only targets fragmented blocks when beneficial, respecting maximum limits

### 4. Receiver Mode Management
- **Three Operational Modes**:
  - `data-scanning`: Scanning for fountain chunks
  - `feedback-display`: Showing feedback QR to sender
  - `ack-scanning`: Scanning for acknowledgment QR from sender
- **State Synchronization**: Ensures proper sequencing between sender and receiver

### 5. Enhanced Feedback QR Generation
- **Contiguous Checksum Calculation**: Computes CRC32 checksum of contiguous decoded blocks from index 0
- **Compact Representation**: Uses range-based encoding for targeted feedback to minimize QR payload size
- **Sequence Tracking**: Maintains feedback sequence numbers for proper acknowledgment handling

### 6. Sender Feedback Processing
- **Acknowledgment Handling**: Processes ACK messages to resume data scanning and expand windows
- **Rollback Support**: Handles sender-initiated rollbacks to specific block indices
- **Sequence Validation**: Prevents duplicate or out-of-order feedback processing

### 7. Performance Optimizations
- **Memoized Calculations**: Uses `useMemo` for expensive operations like `decodedInWindow`
- **Callback Optimization**: Converts debug logging to `useCallback` for better performance
- **Efficient State Management**: Minimizes re-renders through strategic state updates

### 8. Testing and Debugging Features
- **Defrag Test Mode**: Development-only feature to simulate fragmentation by ignoring specific blocks
- **Comprehensive Logging**: Detailed debug logs for all major operations and state changes
- **Error Handling**: Robust error handling with user-friendly messages

## Configuration Parameters

### Window Configuration
```typescript
windowEnabled?: boolean          // Enable/disable windowed transfers
initialWindowBlocks?: number     // Initial window size
windowExpansionFactor?: number   // Window expansion multiplier (default: 0.5)
windowTriggerThreshold?: number  // Window saturation threshold (default: 0.5)
windowStart?: number            // Starting block index (default: 0)
```

### Defrag Configuration (from fountainConfig.ts)
```typescript
DEFRAG_MAX_TARGETS: 10           // Max blocks to target for defrag
DEFRAG_MAX_MISSING_COUNT: 50     // Max missing blocks in prefix window
DEFRAG_PREFIX_WINDOW_BLOCKS: 100 // Absolute prefix window size
DEFRAG_PREFIX_WINDOW_RATIO: 0.1  // Relative prefix window size
DEFRAG_MIN_OVERALL_PROGRESS: 0.3 // Min progress for defrag activation
TARGETED_MODE_MAX_MISSING_BLOCKS: 50 // Threshold for targeted mode
```

## Usage Flow

1. **Initialization**: Component receives metadata with window and session configuration
2. **Data Scanning**: Receiver scans fountain chunks, tracking progress and window saturation
3. **Feedback Trigger**: When conditions met, generates appropriate feedback QR (statistics/targeted)
4. **Feedback Display**: Shows QR to sender, switches to feedback-display mode
5. **ACK Scanning**: Switches to ack-scanning mode to receive sender acknowledgment
6. **Window Expansion**: Upon ACK, expands window and resumes data scanning
7. **Defrag Handling**: Detects fragmentation and requests targeted block transmission
8. **Completion**: File reconstruction when all blocks decoded

## Benefits

- **Improved Efficiency**: Windowed transfers reduce memory requirements for large files
- **Better Reliability**: Feedback mechanisms ensure robust transfer completion
- **Adaptive Performance**: Automatically switches between compact and detailed feedback modes
- **Fragmentation Recovery**: Intelligent gap-filling for interrupted transfers
- **User Experience**: Clear mode indicators and seamless sender-receiver synchronization

## Backward Compatibility

The enhancements maintain backward compatibility with existing fountain transfer implementations while adding optional advanced features that activate based on metadata configuration.
