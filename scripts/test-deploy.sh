#!/bin/bash

# Configuration
PORT=6943
# should be absolute path from script file location like $0
TMP_PATH="$(cd "$(dirname "$0")/.." && pwd)/tmp/testoutput"
OUTPUT_DIR="$TMP_PATH/generated"

# Check if port is in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "Error: Port $PORT is already in use. Please stop the service using that port or choose a different port."
    exit 1
fi

# Ensure tmp directory exists
mkdir -p $TMP_PATH

# Remove existing test output directory
rm -rf $TMP_PATH

# Build the project and output to $OUTPUT_DIR
npm run build -- --outDir $OUTPUT_DIR

echo "Built project to $OUTPUT_DIR"
export CLOUDFLARE_LOG="$TMP_PATH/cloudflare.log"
export TMP_PATH

# Start http-server, cloudflared tunnel, and QR generation concurrently
npx concurrently \
  "npx http-server $OUTPUT_DIR -p $PORT -c-1" \
  "(cloudflared tunnel --url http://localhost:$PORT 2>&1 | tee $CLOUDFLARE_LOG)" \
  "./scripts/generate-qr.sh"
