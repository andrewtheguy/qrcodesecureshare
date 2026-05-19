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
#
# `-channel RGB -negate` inverts only the colour channels; without it
# ImageMagick also negates the alpha channel, producing a fully
# transparent PNG that renders as blank in viewers (the decoder still
# works because it reads RGB and ignores alpha, but the fixture is
# unrealistic). `-alpha off` then drops the (now-irrelevant) alpha
# channel so the on-disk PNG is opaque RGB — matching how a real
# white-on-dark QR photo would arrive.
magick qr_sample.png -channel RGB -negate -alpha off qr_sample_inverted.png

# qr_sample_small_in_canvas.png — exercises `try_harder` in isolation.
# Downscaled to 80x80 and pasted at (40, 40) into a 1600x1600 white canvas.
# `FindFinderPatterns` defaults to skip = (3*1600)/(4*97) ≈ 12; the shrunken
# finder modules are ~3 px tall, so the coarse scan walks past them and
# only the dense `try_harder = true` scan (skip = 3) catches one.
magick -size 1600x1600 xc:white \
  \( qr_sample.png -resize 80x80! \) -geometry +40+40 -composite \
  qr_sample_small_in_canvas.png

# qr_two_codes.png — exercises the multi-symbol decode loop with two
# distinct payloads. qr_sample.png (297x297, payload "jfghjghjghfkghjkghj")
# and qr_code_complex.png (300x300, payload "https://qr-code-styling.com")
# composited side-by-side on a 657x300 white canvas with a 60 px gap.
# qr_sample sits at (0, 1) to vertically center it within the taller (300)
# canvas; qr_code_complex sits flush at (357, 0). `FindFinderPatterns`
# yields two independent triples and `decode_set_number_with_hints`
# returns both payloads when `count` > 1.
magick -size 657x300 xc:white \
  qr_sample.png -geometry +0+1 -composite \
  qr_code_complex.png -geometry +357+0 -composite \
  qr_two_codes.png

# qr_three_codes.png — extends qr_two_codes.png with a second copy of
# qr_sample at the right edge, producing three side-by-side symbols on a
# 1014x300 canvas. Pins that duplicate payloads do NOT collapse into a
# single result and that the multi-decode loop keeps iterating past two.
magick -size 1014x300 xc:white \
  qr_sample.png -geometry +0+1 -composite \
  qr_code_complex.png -geometry +357+0 -composite \
  qr_sample.png -geometry +717+1 -composite \
  qr_three_codes.png

echo "Regenerated:"
ls -l qr_sample_inverted.png qr_sample_small_in_canvas.png qr_two_codes.png qr_three_codes.png
