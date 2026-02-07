#!/bin/bash
set -ex

# Install Rust and Cargo
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

# Build WASM modules
cd rust/fountain-wasm
wasm-pack build --release --target web

cd ../fast-qr-wasm
wasm-pack build --release --target web
