use crate::types::FountainChunk;
use serde::{Deserialize, Serialize};

/// Part metadata extracted from binary chunk data
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartMetadata {
    pub current_part: u16,
    pub total_parts: u16,
    /// Part checksum as 4 bytes (big-endian CRC32)
    #[serde(with = "serde_bytes")]
    pub part_checksum: [u8; 4],
}

/// Result of parsing a binary chunk
#[derive(Debug, Clone)]
pub struct ParsedChunk {
    pub chunk: FountainChunk,
    pub checksum_start: usize,
    pub part_metadata: Option<PartMetadata>,
}

/// Parses a binary chunk into a FountainChunk with metadata
///
/// # Binary Format
/// ```
/// [0-1]:    Magic bytes [0xFF][0xFD]
/// [2-3]:    Seed (u16, big-endian)
/// [4]:      Degree (u8)
/// [5]:      NumIndices (u8)
/// [6-end]:  Indices (2 bytes each, big-endian) - total of numIndices * 2 bytes
/// [next-next+7]:  Optional part metadata (if present):
///                 - Current part (u16, big-endian)
///                 - Total parts (u16, big-endian)
///                 - Part checksum (4 bytes, big-endian)
/// [before_checksum-end-4]: Chunk data
/// [end-4-end]:  CRC32 checksum (4 bytes)
/// ```
///
/// # Arguments
/// * `bytes` - The binary data to parse
/// * `part_based_mode` - Whether part-based mode is enabled
/// * `total_source_blocks` - Total number of source blocks (for validation)
///
/// # Errors
/// Returns an error if:
/// - Chunk is too short
/// - Magic bytes are invalid
/// - NumIndices is out of range
/// - Chunk data is missing
pub fn parse_binary_chunk(
    bytes: &[u8],
    part_based_mode: bool,
    total_source_blocks: usize,
) -> Result<ParsedChunk, String> {
    // Validate minimum length for header (magic 2, seed 2, degree 1, numIndices 1)
    if bytes.len() < 6 {
        return Err("Chunk too short: missing header".to_string());
    }

    // Validate magic bytes [0xFF][0xFD]
    if bytes[0] != 0xFF || bytes[1] != 0xFD {
        return Err("Invalid magic bytes".to_string());
    }

    // Extract seed (2 bytes, big-endian)
    let seed = ((bytes[2] as u32) << 8) | (bytes[3] as u32);

    // Extract degree (1 byte)
    let degree = bytes[4] as usize;

    // Extract numIndices (1 byte)
    let num_indices = bytes[5] as usize;

    // Validate numIndices
    if num_indices == 0 || num_indices > 1000 {
        return Err(format!("Invalid numIndices: {}", num_indices));
    }

    // Validate against total source blocks
    if num_indices > total_source_blocks {
        return Err(format!(
            "Invalid numIndices: {} exceeds total source blocks: {}",
            num_indices, total_source_blocks
        ));
    }

    // Validate that degree matches num_indices (they should be equal)
    if degree != num_indices {
        return Err(format!(
            "Degree mismatch: degree {} != numIndices {}",
            degree, num_indices
        ));
    }

    // Check length for indices (2 bytes each) and checksum (4 bytes)
    let indices_byte_length = num_indices * 2;
    let min_length_with_indices_and_checksum = 6 + indices_byte_length + 4;
    if bytes.len() < min_length_with_indices_and_checksum {
        return Err(
            "Chunk too short: missing indices or checksum".to_string(),
        );
    }

    // Extract indices (2 bytes each, big-endian)
    let mut indices = Vec::with_capacity(num_indices);
    let mut offset = 6;
    for _ in 0..num_indices {
        if offset + 1 >= bytes.len() {
            return Err("Unexpected end of data while reading indices".to_string());
        }
        let index = ((bytes[offset] as usize) << 8) | (bytes[offset + 1] as usize);
        indices.push(index);
        offset += 2;
    }

    // Try to parse part metadata if enabled
    let remaining_bytes = bytes.len() - offset - 4; // Subtract 4 for final checksum
    let mut part_metadata: Option<PartMetadata> = None;

    if part_based_mode && remaining_bytes >= 8 {
        // Check if we have enough bytes for part metadata (8 bytes: 2+2+4)
        if offset + 8 <= bytes.len() - 4 {
            // Extract current part (u16, big-endian)
            let current_part = ((bytes[offset] as u16) << 8) | (bytes[offset + 1] as u16);
            offset += 2;

            // Extract total parts (u16, big-endian)
            let total_parts = ((bytes[offset] as u16) << 8) | (bytes[offset + 1] as u16);
            offset += 2;

            // Extract part checksum (4 bytes, big-endian)
            let mut part_checksum = [0u8; 4];
            for i in 0..4 {
                part_checksum[i] = bytes[offset + i];
            }
            offset += 4;

            part_metadata = Some(PartMetadata {
                current_part,
                total_parts,
                part_checksum,
            });
        }
    }

    // Extract data (between current offset and checksum)
    let checksum_start = bytes.len() - 4;
    if checksum_start < offset {
        return Err("Invalid checksum position: checksumStart < offset".to_string());
    }

    let data = bytes[offset..checksum_start].to_vec();

    // Validate that data is not empty
    if data.is_empty() {
        return Err("Chunk data is empty".to_string());
    }

    // Create the FountainChunk
    let chunk = FountainChunk::new_unchecked(seed as u32, degree, indices, data);

    Ok(ParsedChunk {
        chunk,
        checksum_start,
        part_metadata,
    })
}

/// Validates a CRC32 checksum within binary chunk data
///
/// # Arguments
/// * `bytes` - The full binary chunk data
/// * `checksum_start` - Byte offset where the checksum begins
/// * `computed_checksum` - The computed checksum as a hex string (8 characters)
///
/// # Returns
/// `Ok(true)` if checksums match, `Ok(false)` if they don't, `Err` if validation fails
pub fn validate_chunk_checksum(
    bytes: &[u8],
    checksum_start: usize,
    computed_checksum: &str,
) -> Result<bool, String> {
    // Validate checksum_start is within bounds
    if checksum_start + 4 > bytes.len() {
        return Err("Invalid checksum position".to_string());
    }

    // Extract expected checksum from binary data (last 4 bytes)
    let expected_checksum_hex = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        bytes[checksum_start],
        bytes[checksum_start + 1],
        bytes[checksum_start + 2],
        bytes[checksum_start + 3]
    );

    Ok(computed_checksum.to_lowercase() == expected_checksum_hex.to_lowercase())
}

/// Creates a composite dedup key for chunk identification
/// Combines seed, degree, first index, and last index to prevent false positives
///
/// # Arguments
/// * `seed` - Chunk seed
/// * `degree` - Chunk degree
/// * `indices` - Chunk indices
///
/// # Returns
/// A string key in format "seed:degree:firstIdx:lastIdx"
pub fn create_chunk_key(seed: u32, degree: usize, indices: &[usize]) -> String {
    let first_idx = indices.first().copied().unwrap_or(usize::MAX);
    let last_idx = indices.last().copied().unwrap_or(usize::MAX);
    format!("{}:{}:{}:{}", seed, degree, first_idx, last_idx)
}

/// Serialize a FountainChunk to binary format for testing
/// This is used by tests to create binary chunks from FountainChunk objects
#[cfg(test)]
pub fn serialize_chunk_to_binary(chunk: &FountainChunk, _include_part_metadata: bool) -> Vec<u8> {
    let mut binary = Vec::new();

    // Magic bytes (always 0xFF 0xFD)
    binary.push(0xFF);
    binary.push(0xFD);

    // Seed (2 bytes, big-endian)
    let seed_u16 = (chunk.seed & 0xFFFF) as u16;
    binary.push((seed_u16 >> 8) as u8);
    binary.push(seed_u16 as u8);

    // Degree (1 byte)
    binary.push(chunk.degree as u8);

    // NumIndices (1 byte) - must equal degree
    binary.push(chunk.indices.len() as u8);

    // Indices (each 2 bytes, big-endian)
    for &idx in &chunk.indices {
        let idx_u16 = idx as u16;
        binary.push((idx_u16 >> 8) as u8);
        binary.push(idx_u16 as u8);
    }

    // Part metadata (if included) - skipped for now as it's not in FountainChunk
    // This would come from encoder's part info and would be added here

    // Data
    binary.extend_from_slice(&chunk.data);

    // Checksum (compute CRC32 of everything from position 2 to here, excluding magic bytes)
    let checksum = crate::checksum::crc32(&binary[2..]);
    binary.extend_from_slice(&checksum);

    binary
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_chunk_binary(
        seed: u16,
        degree: u8,
        indices: &[u16],
        data: &[u8],
    ) -> Vec<u8> {
        let mut binary = Vec::new();

        // Magic bytes
        binary.push(0xFF);
        binary.push(0xFD);

        // Seed (2 bytes, big-endian)
        binary.push((seed >> 8) as u8);
        binary.push(seed as u8);

        // Degree
        binary.push(degree);

        // NumIndices
        binary.push(indices.len() as u8);

        // Indices (2 bytes each, big-endian)
        for &idx in indices {
            binary.push((idx >> 8) as u8);
            binary.push(idx as u8);
        }

        // Data
        binary.extend_from_slice(data);

        // Placeholder checksum (4 bytes)
        binary.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);

        binary
    }

    #[test]
    fn test_parse_valid_chunk() {
        let binary = create_test_chunk_binary(42, 2, &[0, 1], &[0xAA, 0xBB]);
        let result = parse_binary_chunk(&binary, false, 10);

        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.chunk.seed, 42);
        assert_eq!(parsed.chunk.degree, 2);
        assert_eq!(parsed.chunk.indices, vec![0, 1]);
        assert_eq!(parsed.chunk.data, vec![0xAA, 0xBB]);
        assert!(parsed.part_metadata.is_none());
    }

    #[test]
    fn test_parse_chunk_invalid_magic_bytes() {
        let mut binary = create_test_chunk_binary(42, 2, &[0, 1], &[0xAA, 0xBB]);
        binary[0] = 0xAA; // Invalid magic
        let result = parse_binary_chunk(&binary, false, 10);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid magic bytes"));
    }

    #[test]
    fn test_parse_chunk_too_short() {
        let binary = vec![0xFF, 0xFD]; // Only magic bytes
        let result = parse_binary_chunk(&binary, false, 10);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too short"));
    }

    #[test]
    fn test_parse_chunk_num_indices_zero() {
        let mut binary = create_test_chunk_binary(42, 0, &[], &[0xAA]);
        binary[5] = 0; // numIndices = 0
        let result = parse_binary_chunk(&binary, false, 10);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid numIndices"));
    }

    #[test]
    fn test_parse_chunk_exceeds_source_blocks() {
        let binary = create_test_chunk_binary(42, 3, &[0, 1, 2], &[0xAA, 0xBB]);
        let result = parse_binary_chunk(&binary, false, 2); // Only 2 source blocks

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("exceeds total source blocks"));
    }

    #[test]
    fn test_validate_checksum_valid() {
        let binary = vec![0xFF, 0xFD, 0x00, 0x2A, 0x01, 0x01, 0x00, 0x00, 0xAA, 0x01, 0x02, 0x03, 0x04];
        let result = validate_chunk_checksum(&binary, 9, "01020304");

        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn test_validate_checksum_mismatch() {
        let binary = vec![0xFF, 0xFD, 0x00, 0x2A, 0x01, 0x01, 0x00, 0x00, 0xAA, 0x01, 0x02, 0x03, 0x04];
        let result = validate_chunk_checksum(&binary, 9, "05060708");

        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn test_create_chunk_key() {
        let key = create_chunk_key(42, 2, &[0, 1, 2]);
        assert_eq!(key, "42:2:0:2");
    }

    #[test]
    fn test_create_chunk_key_single_index() {
        let key = create_chunk_key(100, 1, &[5]);
        assert_eq!(key, "100:1:5:5");
    }

    #[test]
    fn test_parse_chunk_with_part_metadata() {
        let mut binary = Vec::new();
        // Magic bytes
        binary.extend_from_slice(&[0xFF, 0xFD]);
        // Seed
        binary.extend_from_slice(&[0x00, 0x2A]);
        // Degree and NumIndices
        binary.extend_from_slice(&[0x02, 0x02]);
        // Indices
        binary.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        // Part metadata (currentPart, totalParts, partChecksum)
        binary.extend_from_slice(&[0x00, 0x00]); // currentPart = 0
        binary.extend_from_slice(&[0x00, 0x05]); // totalParts = 5
        binary.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]); // partChecksum bytes
        // Data
        binary.extend_from_slice(&[0x42, 0x43]);
        // Checksum
        binary.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);

        let result = parse_binary_chunk(&binary, true, 10);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert!(parsed.part_metadata.is_some());
        let pm = parsed.part_metadata.unwrap();
        assert_eq!(pm.current_part, 0);
        assert_eq!(pm.total_parts, 5);
        assert_eq!(pm.part_checksum, [0xAA, 0xBB, 0xCC, 0xDD]);
    }
}
