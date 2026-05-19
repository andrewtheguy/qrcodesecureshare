use crate::common::Result;
use crate::{Exceptions, Point};

use super::{Direction, RegressionLineTrait};

#[inline(always)]
pub fn intersect<T: RegressionLineTrait, T2: RegressionLineTrait>(
    l1: &T,
    l2: &T2,
) -> Result<Point> {
    if !(l1.isValid() && l2.isValid()) {
        return Err(Exceptions::ILLEGAL_STATE);
    }
    let d = l1.a() * l2.b() - l1.b() * l2.a();
    if d.abs() < f32::EPSILON {
        return Err(Exceptions::ILLEGAL_STATE);
    }
    let x = (l1.c() * l2.b() - l1.b() * l2.c()) / d;
    let y = (l1.a() * l2.c() - l1.c() * l2.a()) / d;
    Ok(Point { x, y })
}

#[allow(dead_code)]
#[inline(always)]
pub fn opposite(dir: Direction) -> Direction {
    if dir == Direction::Left {
        Direction::Right
    } else {
        Direction::Left
    }
}

#[inline(always)]
pub fn UpdateMinMax<T: Ord + Copy>(min: &mut T, max: &mut T, val: T) {
    *min = std::cmp::min(*min, val);
    *max = std::cmp::max(*max, val);
}

#[inline(always)]
pub fn UpdateMinMaxFloat(min: &mut f64, max: &mut f64, val: f64) {
    *min = f64::min(*min, val);
    *max = f64::max(*max, val);
}

pub fn ToString<T: Into<usize>>(val: T, len: usize) -> Result<String> {
    let mut val: usize = val.into();
    let mut result = vec!['0'; len];
    let mut idx = len;
    while idx > 0 && val != 0 {
        idx -= 1;
        result[idx] = char::from(b'0' + (val % 10) as u8);
        val /= 10;
    }
    if val != 0 {
        return Err(Exceptions::format_with("Invalid value"));
    }

    Ok(result.iter().collect())
}

pub fn ToInt(a: &[u32]) -> Option<u32> {
    if a.iter().sum::<u32>() > 32 {
        return None;
    }

    let mut pattern = 0;
    for (i, element) in a.iter().copied().enumerate() {
        pattern = (pattern << element) | (!(0xffffffff << element) * (!i & 1) as u32);
    }

    Some(pattern)
}

pub fn AppendBit(val: &mut i32, bit: bool) {
    *val <<= 1;

    *val |= i32::from(bit)
}

pub fn ToIntPos(bits: &[u8], pos: usize, count: usize) -> Option<u32> {
    let count = std::cmp::min(count, bits.len().saturating_sub(pos));
    let mut res = 0;
    for bit in bits.iter().skip(pos).take(count) {
        AppendBit(&mut res, *bit != 0);
    }

    Some(res as u32)
}
