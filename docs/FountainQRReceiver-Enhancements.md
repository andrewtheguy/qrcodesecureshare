# FountainQRReceiver New Techniques and Enhancements on v0.1.8

## Overview
The `FountainQRReceiver.tsx` component has been significantly enhanced with advanced feedback mechanisms and part-based transfer support. These improvements enable more efficient and robust fountain code transfers, especially for larger files.



## Key New Features

### 1. Part-Based Transfer Support
- **Purpose**: Enables progressive file transfer by dividing large files into manageable parts
- **Configuration**: Configurable part sizes (32KB, 256KB, 512KB, 1024KB)
- **Benefits**: Reduces memory usage and improves transfer efficiency for large files
- **Implementation**: Tracks current part index and validates part checksums independently

### 2. Advanced Feedback System
- **Multi-Mode Feedback**: Supports both 'statistics' (compact) and 'targeted' (detailed) feedback modes
- **Priority-Based Triggers**: Implements mutually exclusive feedback generation with strict priority ordering:
  1. **Part Completion** (Highest Priority): Triggers when a part is fully decoded and checksum validated
  2. **Targeted Mode**: Activates when missing blocks drop below `TARGETED_MODE_MAX_MISSING_BLOCKS` for final cleanup


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
- **Acknowledgment Handling**: Processes ACK messages to resume data scanning and coordinate part transitions
- **Part Transition Support**: Handles sender signals to move to the next part when current part is complete
- **Sequence Validation**: Prevents duplicate or out-of-order feedback processing


### 8. Testing and Debugging Features
- **Targeted Mode Test**: Development-only feature to simulate targeted mode by ignoring specific blocks
- **Comprehensive Logging**: Detailed debug logs for all major operations and state changes
- **Error Handling**: Robust error handling with user-friendly messages

## Configuration Parameters

### Part-Based Transfer Configuration
```typescript
PART_SIZE_OPTIONS: {
  TINY: 32 * 1024,    // 32KB (for testing)
  SMALL: 256 * 1024,  // 256KB
  MEDIUM: 512 * 1024, // 512KB
  LARGE: 1024 * 1024, // 1MB (1024KB)
}
```

### Fountain Code Configuration Updates
```typescript
DEFAULT_BLOCK_SIZE: 400          // Reduced from 600 bytes for smaller data QR codes
TARGETED_MODE_MAX_MISSING_BLOCKS: 10 // Final cleanup threshold
ENABLE_TARGETED_MODE: false      // Temporarily disabled for part-based testing
```

## Usage Flow

1. **Initialization**: Component receives metadata with part-based configuration and session info
2. **Data Scanning**: Receiver scans fountain chunks at optimized 4 FPS, tracking progress within current part
3. **Feedback Trigger**: When part completion or other conditions met, generates appropriate feedback QR (statistics/targeted)
4. **Feedback Display**: Shows QR to sender, switches to feedback-display mode
5. **ACK Scanning**: Switches to ack-scanning mode to receive sender acknowledgment
6. **Part Transition**: Upon ACK with part transition signal, moves to next part and resumes data scanning
7. **Completion**: File reconstruction when all parts are decoded and validated


## Benefits

- **Improved Efficiency**: Part-based transfers reduce memory requirements for large files
- **Better Reliability**: Part checksums and feedback mechanisms ensure robust transfer completion
- **Adaptive Performance**: Automatically switches between compact and detailed feedback modes
- **User Experience**: Clear mode indicators and seamless sender-receiver synchronization
- **Independent Validation**: Each part is validated independently with CRC32 checksums

## QR Scanning & Encoding Implementation

### Current Technology Stack

**QR Code Scanning:**
- **ZXing WASM**: All QR code scanning throughout the application uses ZXing WASM (WebAssembly-based scanner)
- **Implementation**: `src/workers/zxing-qr-scanner.worker.ts` provides a web worker interface for scanning
- **Performance**: Optimized for both mobile (8 fps) and desktop (15+ fps) scanning
- **Advantages**: High accuracy, fast processing, and efficient battery usage on mobile devices

**Binary Data Encoding:**
- **Fountain Codes**: Binary-compatible encoding using fountain (LT) codes with Robust Soliton distribution
- **Configuration**: Block size set to 400 bytes for optimal QR code density
- **Part-Based Transfer**: Divides large files into configurable parts (32KB-1MB) for reduced memory usage
- **Data Format**: Magic bytes [0xFF][0xFD], 2-byte seed, 1-byte degree, variable-length indices and data with CRC32 checksum

**QR Code Generation:**
- **qrcode Library**: Retained for one-off QR code generation (simple text/URL QR codes)
- **Background Generation**: `src/workers/qrGenerator.worker.ts` handles generation in web worker threads
- **Future Encoder**: Will migrate to Sequential Scanning ZXing WASM encoder for binary mode transfers for consistency and better performance

### Scanning Workflow

1. **Data Scanning**: Receiver scans fountain code chunks at optimized FPS rates
2. **Chunk Parsing**: ZXing WASM decodes QR codes, fountain decoder extracts binary data
3. **Block Assembly**: Decoded chunks are collected and processed via web worker
4. **Feedback Generation**: Statistical or targeted feedback is generated and displayed as QR
5. **Continuous Transfer**: Process repeats until all blocks are received or file is completely reconstructed

## Backward Compatibility

The optimized components use a new format incompatible with legacy components. Legacy components have been removed. Only data QR codes are optimized for easier scanning, while feedback QR codes remain at their original size.
- **QR Generation**: `qrGenerator.worker.ts` handles background QR generation
- **QR Scanning**: `zxing-qr-scanner.worker.ts` handles QR scanning with ZXing WASM
- **Configuration**: `fountainConfig.ts` contains block size parameters
- **Related Files**: `FountainQRSender.tsx`, `FountainQRReceiver.tsx`, `fountainCode.ts`
