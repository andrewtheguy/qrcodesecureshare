#[derive(Debug, Hash, PartialEq, Eq, Clone, Copy)]
pub enum Type {
    Model1,
    Model2,
    Micro,
    RectMicro,
}

impl Type {
    // Const-callable equality: derived `PartialEq::eq` (i.e. `a == b`) is not
    // usable in `const fn` on stable Rust, but `Version::isMicro`/`isModel1`/
    // `isModel2`/`isRMQR` are declared `const fn` and compare `Type` values.
    pub const fn const_eq(a: Type, b: Type) -> bool {
        let (a, b) = (a as u8, b as u8);

        a == b
    }
}
