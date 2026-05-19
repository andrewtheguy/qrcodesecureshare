#!/usr/bin/env bash
# Regenerate the synthetic decode-option fixtures from qr_sample.png.
# Requires ImageMagick v7 (`magick`).
#
# Usage: from the fixtures directory, run `./regen_synthetic.sh`.
#
# The resulting PNGs are committed to the repo so tests don't depend on
# ImageMagick at test time — only regenerate when qr_sample.png changes.
set -euo pipefail
cd "$(dirname "$0")"

# qr_sample_inverted.png — exercises `try_invert` in isolation.
# Pixel-inverted (255 - rgb per channel). The QrReader multi-decode path
# doesn't consume the AlsoInverted hint, so this fixture only decodes when
# the caller flips the BitMatrix manually (try_invert = true).
magick qr_sample.png -negate qr_sample_inverted.png

# qr_sample_small_in_canvas.png — exercises `try_harder` in isolation.
# Downscaled to 80x80 and pasted at (40, 40) into a 1600x1600 white canvas.
# `FindFinderPatterns` defaults to skip = (3*1600)/(4*97) ≈ 12; the shrunken
# finder modules are ~3 px tall, so the coarse scan walks past them and
# only the dense `try_harder = true` scan (skip = 3) catches one.
magick -size 1600x1600 xc:white \
  \( qr_sample.png -resize 80x80! \) -geometry +40+40 -composite \
  qr_sample_small_in_canvas.png

echo "Regenerated:"
ls -l qr_sample_inverted.png qr_sample_small_in_canvas.png
