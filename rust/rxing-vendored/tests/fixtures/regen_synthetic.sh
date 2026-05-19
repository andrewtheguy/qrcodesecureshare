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

# qr_sample_rotated_speckled.png — exercises `try_harder` (close-pass) on a
# clean, synthetic source. In-memory analog of the real-phone-photo
# qr_code_complex_rotated.jpg fixture, but built from qr_sample.png so the
# failure mode is isolated to "rotation aliasing + white-salt noise inside
# black modules".
#
# Step 1: nearest-neighbor rotate 17° about the source center, expanding the
# canvas to 373×373 (≈ 297·(|cos17°|+|sin17°|), pre-centered via SRT). `-rotate`
# is avoided because its built-in algorithm anti-aliases even with
# `-filter point`; `-distort SRT` honours the point filter and produces clean
# nearest-neighbor staircase edges.
#
# Step 2: lighten-composite a sparse white-on-black noise mask (1 - 80% = 20%
# of pixels go white) onto the rotated image. This punches 1-pixel white holes
# inside the dark finder bars — too disruptive for the original-resolution
# scan but exactly what `try_harder = true`'s morphological close-pass fills.
# `-seed 42` keeps the noise reproducible.
magick qr_sample.png -filter point \
  -define distort:viewport=373x373 \
  -distort SRT '148.5,148.5 1 17 186.5,186.5' \
  -background white -alpha off /tmp/qr_sample_rotated.png
magick /tmp/qr_sample_rotated.png \
  \( -size 373x373 xc:black -seed 42 +noise random -threshold 80% \) \
  -compose lighten -composite -alpha off \
  qr_sample_rotated_speckled.png
rm -f /tmp/qr_sample_rotated.png

# qr_sample_vignetted.png — exercises the HybridBinarizer branch in isolation.
# qr_sample.png multiplied by a radial gradient from white (centre) to gray50
# (corners), producing a strong dark vignette that drops the corner luminance
# to ~50% of centre while preserving local black/white contrast within each
# small neighbourhood. GlobalHistogramBinarizer's single image-wide threshold
# cannot separate the dim-corner whites from the bright-centre blacks (the
# histogram peaks overlap), so it misses on every combo; HybridBinarizer's
# per-8×8-block thresholds adapt to the local luminance and decode cleanly.
# Mirror of qr-complex-2.png (which fails on Hybrid and decodes on Global) —
# together they pin both binarizer branches as load-bearing.
magick qr_sample.png \
  \( -size 297x297 radial-gradient:white-gray50 \) \
  -compose multiply -composite -alpha off \
  qr_sample_vignetted.png

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
ls -l qr_sample_inverted.png qr_sample_small_in_canvas.png qr_two_codes.png qr_three_codes.png qr_sample_rotated_speckled.png qr_sample_vignetted.png
