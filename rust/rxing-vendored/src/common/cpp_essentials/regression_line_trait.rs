use crate::common::Result;
use crate::{Point, point};

pub trait RegressionLineTrait {
    fn intersect<T: RegressionLineTrait, T2: RegressionLineTrait>(
        l1: &T,
        l2: &T2,
    ) -> Option<Point> {
        if !(l1.isValid() && l2.isValid()) {
            return None;
        }

        let d = l1.a() * l2.b() - l1.b() * l2.a();
        if d.abs() < f32::EPSILON {
            return None;
        }
        let x = (l1.c() * l2.b() - l1.b() * l2.c()) / d;
        let y = (l1.a() * l2.c() - l1.c() * l2.a()) / d;

        Some(point(x, y))
    }

    fn evaluate(&mut self, points: &[Point]) -> bool;
    fn evaluateSelf(&mut self) -> bool;

    fn points(&self) -> &[Point];
    fn length(&self) -> u32;
    fn isValid(&self) -> bool;
    fn normal(&self) -> Point;
    fn signedDistance(&self, p: Point) -> f32;
    fn distance_single(&self, p: Point) -> f32;
    fn project(&self, p: Point) -> Point {
        p - self.normal() * self.signedDistance(p)
    }

    fn reset(&mut self);

    fn add(&mut self, p: Point) -> Result<()>;

    fn pop_back(&mut self);

    fn setDirectionInward(&mut self, d: Point);

    fn evaluate_max_distance(
        &mut self,
        maxSignedDist: Option<f64>,
        updatePoints: Option<bool>,
    ) -> bool;

    fn isHighRes(&self) -> bool;
    fn a(&self) -> f32;
    fn b(&self) -> f32;
    fn c(&self) -> f32;
}
