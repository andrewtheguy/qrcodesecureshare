#!/bin/bash
set -ex

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install Rust and Cargo
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

# Build WASM modules
pushd "$BASE_DIR/rust/fountain-wasm"
wasm-pack build --release --target web
popd

pushd "$BASE_DIR/rust/fast-qr-wasm"
wasm-pack build --release --target web
popd
