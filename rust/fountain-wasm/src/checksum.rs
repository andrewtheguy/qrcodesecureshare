use crc32fast::Hasher;

/// Compute CRC32 checksum and return as lowercase hex string
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
}
