use crate::common::Result;
use crate::{Exceptions, Point};

#[derive(Default, Clone, PartialEq, Eq)]
pub struct Matrix<T: Default + Clone + Copy> {
    width: usize,
    height: usize,
    data: Vec<Option<T>>,
}

impl<T: Default + Clone + Copy> Matrix<T> {
    pub fn with_data(width: usize, height: usize, data: Vec<Option<T>>) -> Result<Matrix<T>> {
        let expected = width.checked_mul(height).ok_or_else(|| {
            Exceptions::illegal_argument_with("invalid size: width * height overflow")
        })?;
        if data.len() != expected {
            return Err(Exceptions::illegal_argument_with(
                "invalid size: data length does not match width * height",
            ));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    pub fn new(width: usize, height: usize) -> Result<Matrix<T>> {
        if width != 0 && (width * height) / width != height {
            return Err(Exceptions::illegal_argument_with(
                "invalid size: width * height is too big",
            ));
        }
        Ok(Self {
            width,
            height,
            data: vec![None; width * height],
        })
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn size(&self) -> usize {
        self.data.len()
    }

    fn get_offset(x: usize, y: usize, width: usize) -> usize {
        y * width + x
    }

    pub fn get(&self, x: usize, y: usize) -> Option<T> {
        if x >= self.width || y >= self.height {
            None
        } else if let Some(Some(d)) = self.data.get(Self::get_offset(x, y, self.width)) {
            Some(*d)
        } else {
            None
        }
    }

    pub fn set(&mut self, x: usize, y: usize, value: T) -> T {
        self.data[Self::get_offset(x, y, self.width)] = Some(value);
        self.get(x, y).unwrap()
    }

    pub fn get_point(&self, p: Point) -> Option<T> {
        self.get(p.x as usize, p.y as usize)
    }

    pub fn set_point(&mut self, p: Point, value: T) -> T {
        assert!(
            p.x.is_finite() && p.y.is_finite(),
            "set_point: non-finite coordinates ({}, {})",
            p.x,
            p.y
        );
        assert!(
            p.x >= 0.0 && p.y >= 0.0,
            "set_point: negative coordinates ({}, {})",
            p.x,
            p.y
        );
        self.set(p.x as usize, p.y as usize, value)
    }

    pub fn data(&self) -> &[Option<T>] {
        &self.data
    }

    pub fn clear_with(&mut self, value: T) {
        self.data.fill(Some(value))
    }

    pub fn clear(&mut self) {
        self.data.fill(None)
    }
}
