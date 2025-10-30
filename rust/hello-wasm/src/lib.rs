use wasm_bindgen::prelude::*;

/// Returns a hello world message from Rust WASM
#[wasm_bindgen]
pub fn hello_world() -> String {
    "Hello from Rust WASM!".to_string()
}

/// Returns a custom greeting with the provided name
#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! This message comes from Rust WASM.", name)
}
