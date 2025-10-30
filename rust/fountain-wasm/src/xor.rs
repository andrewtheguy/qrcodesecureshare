/// XOR multiple blocks together
/// Takes a list of blocks and XORs them all together
/// All blocks must have the same length
pub fn xor_blocks(blocks: &[&[u8]]) -> Vec<u8> {
    if blocks.is_empty() {
        return Vec::new();
    }

    let block_size = blocks[0].len();
    let mut result = vec![0u8; block_size];

    for block in blocks {
        assert_eq!(
            block.len(),
            block_size,
            "All blocks must have the same length"
        );
        xor_into(&mut result, block);
    }

    result
}

/// XOR one block into another (in-place)
pub fn xor_into(dest: &mut [u8], src: &[u8]) {
    assert_eq!(dest.len(), src.len(), "Blocks must have the same length");

    for (d, s) in dest.iter_mut().zip(src.iter()) {
        *d ^= *s;
    }
}

/// XOR a block into a destination starting at a specific offset
pub fn xor_into_offset(dest: &mut [u8], src: &[u8], offset: usize) {
    let len = src.len();

    // Use checked arithmetic to prevent overflow in bounds check
    let end = offset.checked_add(len).expect(
        "Source block doesn't fit in destination at offset (overflow: offset + len exceeds usize::MAX)"
    );

    assert!(
        end <= dest.len(),
        "Source block doesn't fit in destination at offset (end={} exceeds dest.len()={})",
        end,
        dest.len()
    );

    for i in 0..len {
        dest[offset + i] ^= src[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xor_blocks_single() {
        let block = vec![0x12, 0x34, 0x56, 0x78];
        let result = xor_blocks(&[&block]);
        assert_eq!(result, block);
    }

    #[test]
    fn test_xor_blocks_two() {
        let block1 = vec![0xFF, 0x00, 0xAA, 0x55];
        let block2 = vec![0x0F, 0xF0, 0x55, 0xAA];
        let result = xor_blocks(&[&block1, &block2]);
        assert_eq!(result, vec![0xF0, 0xF0, 0xFF, 0xFF]);
    }

    #[test]
    fn test_xor_blocks_three() {
        let block1 = vec![0xFF, 0x00];
        let block2 = vec![0xF0, 0x0F];
        let block3 = vec![0x0F, 0xF0];
        let result = xor_blocks(&[&block1, &block2, &block3]);
        assert_eq!(result, vec![0x00, 0xFF]);
    }

    #[test]
    fn test_xor_into() {
        let mut dest = vec![0xFF, 0x00, 0xAA, 0x55];
        let src = vec![0x0F, 0xF0, 0x55, 0xAA];
        xor_into(&mut dest, &src);
        assert_eq!(dest, vec![0xF0, 0xF0, 0xFF, 0xFF]);
    }

    #[test]
    fn test_xor_into_offset() {
        let mut dest = vec![0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00];
        let src = vec![0xAA, 0x55];
        xor_into_offset(&mut dest, &src, 2);
        assert_eq!(dest, vec![0x00, 0x00, 0x55, 0xAA, 0x00, 0x00]);
    }

    #[test]
    #[should_panic]
    fn test_xor_blocks_different_sizes() {
        let block1 = vec![0xFF, 0x00];
        let block2 = vec![0xF0];
        xor_blocks(&[&block1, &block2]);
    }
}
