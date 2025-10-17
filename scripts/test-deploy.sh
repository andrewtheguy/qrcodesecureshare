#!/bin/bash

# Configuration
PORT=6943

# Check if port is in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "Error: Port $PORT is already in use. Please stop the service using that port or choose a different port."
    exit 1
fi

# Ensure tmp directory exists
mkdir -p tmp

# Remove existing test output directory
rm -f tmp/qr-code.png
rm -rf tmp/testoutput

# Build the project and output to tmp/testoutput
npm run build -- --outDir tmp/testoutput

# Start http-server in background
npx http-server tmp/testoutput -p $PORT -c-1 &
SERVER_PID=$!

# Start cloudflared tunnel in background, output to log file and stdout
npx cloudflared tunnel --url http://localhost:$PORT | tee tmp/cloudflare.log 2>&1 &
CLOUDFLARE_PID=$!

# Wait for the Cloudflare URL to appear in the log
while ! grep -q "https://.*trycloudflare.com" tmp/cloudflare.log; do
    sleep 1
done

# Extract the URL
URL=$(grep "https://.*trycloudflare.com" tmp/cloudflare.log | head -1 | sed 's/.*https:\/\//https:\/\//' | sed 's/|$//' | tr -d ' ')

if [ -z "$URL" ]; then
    echo "Error: Failed to extract Cloudflare URL"
    kill $SERVER_PID $CLOUDFLARE_PID 2>/dev/null
    exit 1
fi

# Extract subdomain
SUBDOMAIN=$(echo "$URL" | sed 's|https://||' | sed 's|\.trycloudflare\.com||')

echo "Cloudflare URL: $URL"
echo "Subdomain: $SUBDOMAIN"
echo "$SUBDOMAIN"

# Generate QR code
node -e "
const QRCode = require('qrcode');
QRCode.toFile('tmp/qr-code.png', '$URL', { width: 300 }, function (err) {
    if (err) {
        console.error('Failed to generate QR code:', err);
        process.exit(1);
    }
    console.log('QR code generated');
});
"

# Add subdomain text under the QR code using ImageMagick
if command -v magick >/dev/null 2>&1; then
    magick tmp/qr-code.png -background white -fill black -gravity center -pointsize 20 label:\"$SUBDOMAIN\" -append tmp/qr-code.png
    echo "QR code with subdomain text saved to tmp/qr-code.png"
elif command -v convert >/dev/null 2>&1; then
    convert tmp/qr-code.png -background white -fill black -gravity center -pointsize 20 label:\"$SUBDOMAIN\" -append tmp/qr-code.png
    echo "QR code with subdomain text saved to tmp/qr-code.png"
else
    echo "ImageMagick not found. QR code saved without text to tmp/qr-code.png"
    echo "Subdomain: $SUBDOMAIN"
fi

# Wait for both processes
wait $SERVER_PID $CLOUDFLARE_PID