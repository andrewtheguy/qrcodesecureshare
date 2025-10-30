use crc32fast::Hasher;

/// Compute CRC32 checksum and return as lowercase hex string (8 characters)
///
/// # Arguments
/// * `data` - The data to checksum
///
/// # Returns
/// Lowercase hexadecimal string representation of CRC32 (e.g., "0d4a1185")
pub fn crc32(data: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(data);
    let checksum = hasher.finalize();
    format!("{:08x}", checksum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc32_empty() {
        let result = crc32(&[]);
        assert_eq!(result, "00000000");
    }

    #[test]
    fn test_crc32_basic() {
        let data = b"hello world";
        let result = crc32(data);
        // Known CRC32 of "hello world" is 0x0d4a1185
        assert_eq!(result, "0d4a1185");
    }

    #[test]
    fn test_crc32_with_nulls() {
        let data = b"\x00\x01\x02\x03";
        let result = crc32(data);
        assert_eq!(result, "8bb98613");
    }

    #[test]
    fn test_crc32_longer_string() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let result = crc32(data);
        // CRC32 of the pangram string
        assert_eq!(result, "414fa339");
    }

    #[test]
    fn test_crc32_repeated_pattern() {
        let data = b"AAAAAAAAAA"; // 10 'A' characters
        let result = crc32(data);
        assert_eq!(result, "478ed0cf");
    }

    #[test]
    fn test_crc32_binary_data() {
        let data: &[u8] = &[0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA];
        let result = crc32(data);
        assert_eq!(result, "c0f083e9");
    }
}
