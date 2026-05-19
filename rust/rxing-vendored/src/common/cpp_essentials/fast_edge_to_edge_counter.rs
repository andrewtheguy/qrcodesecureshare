use crate::common::BitMatrix;

use super::BitMatrixCursorTrait;

pub struct FastEdgeToEdgeCounter<'a> {
    p: u32,
    stride: isize,
    stepsToBorder: i32,
    _arr: isize,
    under_array: &'a BitMatrix,
}

impl FastEdgeToEdgeCounter<'_> {
    pub fn new<T: BitMatrixCursorTrait>(cur: &'_ T) -> FastEdgeToEdgeCounter<'_> {
        let stride = cur.d().y as isize * cur.img().width() as isize + cur.d().x as isize;
        // NOTE: P IS SET WRONG IN REVERSE
        let p = ((cur.p().y as isize * cur.img().width() as isize).abs() as i32 + cur.p().x as i32)
            as u32;

        let maxStepsX: i32 = if cur.d().x != 0.0 {
            if cur.d().x > 0.0 {
                cur.img().width() as i32 - 1 - cur.p().x as i32
            } else {
                cur.p().x as i32
            }
        } else {
            i32::MAX
        };
        let maxStepsY: i32 = if cur.d().y != 0.0 {
            if cur.d().y > 0.0 {
                cur.img().height() as i32 - 1 - cur.p().y as i32
            } else {
                cur.p().y as i32
            }
        } else {
            i32::MAX
        };
        let stepsToBorder = std::cmp::min(maxStepsX, maxStepsY);

        FastEdgeToEdgeCounter {
            p,
            stride,
            stepsToBorder,
            _arr: cur.p().y as isize * stride,
            under_array: cur.img(),
        }
    }

    pub fn stepToNextEdge(&mut self, range: u32) -> u32 {
        let maxSteps = std::cmp::min(self.stepsToBorder, range as i32);
        let mut steps = 0;
        loop {
            steps += 1;
            if steps > maxSteps {
                if maxSteps == self.stepsToBorder {
                    break;
                } else {
                    return 0;
                }
            }

            let idx_pt = self.get_array_check_index(steps);

            if self.under_array.get_index(idx_pt) != self.under_array.get_index(self.p as usize) {
                break;
            }
        }

        // Saturate at 0 instead of wrapping via unsigned_abs. The loop above can
        // exit one step past the border (the `maxSteps == stepsToBorder` break path
        // increments `steps` to `maxSteps + 1`), which can yield a negative index
        // for negative stride. Caller never re-reads `self.p` in that terminal case,
        // but clamping keeps `self.p` in a defined state.
        let new_pos = self.p as isize + (steps as isize * self.stride);
        self.p = new_pos.max(0) as u32;
        self.stepsToBorder -= steps;

        steps as u32
    }

    #[inline(always)]
    fn get_array_check_index(&self, steps: i32) -> usize {
        let idx = self.p as isize + (steps as isize * self.stride);
        assert!(
            idx >= 0,
            "get_array_check_index: computed negative index (p={}, stride={}, steps={})",
            self.p,
            self.stride,
            steps
        );
        idx as usize
    }
}
