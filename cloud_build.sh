#!/bin/bash
# The Cloudflare Pages build (`bun run build:cloud`). Its image has no Rust, so
# this installs rustup first; the toolchain and the wasm target themselves come
# from wasm/fountain/rust-toolchain.toml.
set -ex

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain none
source "$HOME/.cargo/env"
(cd "$BASE_DIR/wasm/fountain" && rustup toolchain install)

cd "$BASE_DIR"
bun run build
