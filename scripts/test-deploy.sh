#!/bin/bash

# Configuration
PORT=6943

# Check if port is in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "Error: Port $PORT is already in use. Please stop the service using that port or choose a different port."
    exit 1
fi

# Remove existing test output directory
rm -rf tmp/testoutput

# Build the project and output to tmp/testoutput
npm run build -- --outDir tmp/testoutput

# Run static file server and cloudflared tunnel concurrently
npx concurrently --kill-others "npx http-server tmp/testoutput -p $PORT -c-1" "npx cloudflared tunnel --url http://localhost:$PORT"