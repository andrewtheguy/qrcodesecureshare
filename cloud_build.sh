#!/bin/bash
set -ex

# Install Rust and Cargo
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

# Build WASM module
cd rust/fountain-wasm
wasm-pack build --release --target web
