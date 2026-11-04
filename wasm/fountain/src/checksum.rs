use crc32fast::Hasher;

/// Compute CRC32 checksum and return as 4 bytes (big-endian)
///
/// # Arguments
/// * `data` - The data to checksum
///
/// # Returns
/// 4-byte array representing the CRC32 checksum in big-endian format
pub fn crc32(data: &[u8]) -> [u8; 4] {
    let mut hasher = Hasher::new();
    hasher.update(data);
    let checksum = hasher.finalize();
    // Convert u32 to 4 bytes in big-endian order
    checksum.to_be_bytes()
}

/// Convert CRC32 bytes to lowercase hex string
///
/// # Arguments
/// * `checksum_bytes` - The 4-byte checksum
///
/// # Returns
/// Lowercase hexadecimal string representation (e.g., "0d4a1185")
pub fn crc32_to_hex(checksum_bytes: &[u8; 4]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        checksum_bytes[0], checksum_bytes[1], checksum_bytes[2], checksum_bytes[3]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc32_empty() {
        let result = crc32(&[]);
        assert_eq!(result, [0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn test_crc32_basic() {
        let data = b"hello world";
        let result = crc32(data);
        // Known CRC32 of "hello world" is 0x0d4a1185 (big-endian bytes)
        assert_eq!(result, [0x0d, 0x4a, 0x11, 0x85]);
    }

    #[test]
    fn test_crc32_with_nulls() {
        let data = b"\x00\x01\x02\x03";
        let result = crc32(data);
        // 0x8bb98613 in big-endian bytes
        assert_eq!(result, [0x8b, 0xb9, 0x86, 0x13]);
    }

    #[test]
    fn test_crc32_longer_string() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let result = crc32(data);
        // CRC32 0x414fa339 in big-endian bytes
        assert_eq!(result, [0x41, 0x4f, 0xa3, 0x39]);
    }

    #[test]
    fn test_crc32_repeated_pattern() {
        let data = b"AAAAAAAAAA"; // 10 'A' characters
        let result = crc32(data);
        // 0x478ed0cf in big-endian bytes
        assert_eq!(result, [0x47, 0x8e, 0xd0, 0xcf]);
    }

    #[test]
    fn test_crc32_binary_data() {
        let data: &[u8] = &[0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA];
        let result = crc32(data);
        // 0xc0f083e9 in big-endian bytes
        assert_eq!(result, [0xc0, 0xf0, 0x83, 0xe9]);
    }

    #[test]
    fn test_crc32_to_hex() {
        let bytes = [0x0d, 0x4a, 0x11, 0x85];
        let hex = crc32_to_hex(&bytes);
        assert_eq!(hex, "0d4a1185");
    }

    #[test]
    fn test_crc32_roundtrip() {
        let data = b"test data";
        let bytes = crc32(data);
        let hex = crc32_to_hex(&bytes);
        // Verify hex representation is correct
        assert_eq!(hex.len(), 8);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
