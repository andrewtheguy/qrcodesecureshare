#!/bin/bash
set -e

# require it to be run by test-deploy.sh
if [ -z "$CLOUDFLARE_LOG" ]; then
    echo "Error: This script must be run by test-deploy.sh"
    exit 1
fi

# Wait for the Cloudflare URL to appear in the log
while ! grep -q "https://.*trycloudflare.com" $CLOUDFLARE_LOG; do
    sleep 1
done

# Extract the URL
URL=$(grep "https://.*trycloudflare.com" $CLOUDFLARE_LOG | head -1 | sed 's/.*https:\/\//https:\/\//' | sed 's/|$//' | tr -d ' ')

# Extract subdomain
SUBDOMAIN=$(echo "$URL" | sed 's|https://||' | sed 's|\.trycloudflare\.com||')

echo "Cloudflare URL: $URL"
echo "Subdomain: $SUBDOMAIN"
echo "$SUBDOMAIN"

# Generate QR code
node -e "
const QRCode = require('qrcode');
QRCode.toFile('$TMP_PATH/qr-code.png', '$URL', { width: 300 }, function (err) {
    if (err) {
        console.error('Failed to generate QR code:', err);
        process.exit(1);
    }
    console.log('QR code generated');
});
"

# Add subdomain text under the QR code using ImageMagick
if command -v magick >/dev/null 2>&1; then
    magick $TMP_PATH/qr-code.png -background white -fill black -gravity center -pointsize 20 label:\"$SUBDOMAIN\" -append $TMP_PATH/qr-code.png
    echo "QR code with subdomain text saved to $TMP_PATH/qr-code.png"
elif command -v convert >/dev/null 2>&1; then
    convert $TMP_PATH/qr-code.png -background white -fill black -gravity center -pointsize 20 label:\"$SUBDOMAIN\" -append $TMP_PATH/qr-code.png
    echo "QR code with subdomain text saved to $TMP_PATH/qr-code.png"
else
    echo "ImageMagick not found. QR code saved without text to $TMP_PATH/qr-code.png"
    echo "Subdomain: $SUBDOMAIN"
fi

# write url to cloudflare-url.txt
echo "$URL" > $TMP_PATH/cloudflare-url.txt
echo "Cloudflare URL text also saved to $TMP_PATH/cloudflare-url.txt"