# Roadmap

## File transfer scanning throughput

Done so far, in `src/hooks/useRxingQRScanner.ts`:

- The rxing worker is created once per scanner rather than on every receiver
  re-render. It holds one frame at a time and reads the newest frame as soon
  as it is free, and frames come from `requestVideoFrameCallback` so each
  camera frame is offered once.
- Frames go to the worker as `ImageBitmap`s, and the worker reads the pixels on
  its own `OffscreenCanvas`, so the page's thread no longer waits on a
  `getImageData` readback. Browsers without `OffscreenCanvas` read on a page
  canvas that is resized only when the video's size changes. With the page's
  thread slowed 6× in headless Chrome, a transfer went from 16–18 to about 22
  frames read per second.
- The file-transfer receiver decodes in two workers (`workerCount`, capped at
  one fewer than the device's cores), each holding one frame. With each decode
  made 40 ms slower in headless Chrome, a transfer went from about 20 to 30
  frames read per second, the camera's rate; at 80 ms slower, from about 11 to
  23.
- The receiver drops a read whose bytes match the read before it
  (`debounceMs: Number.POSITIVE_INFINITY`), since that is the same chunk seen
  in consecutive camera frames. The hook now keeps a copy of the last read, so
  the check still works after the receiver transfers the read's buffer to the
  decoder worker. With each chunk shown for two camera frames, the decoder
  worker gets half as many chunks, and the transfer takes as long.
- Per-read and per-chunk logging is gone from `FountainQRDataScanner`,
  `FountainQRReceiver` and `fountainDecoder.worker.ts`.

Checked on a real phone:

- **Camera resolution.** A 1 KB fountain chunk at the sender's error
  correction L and 1-module margin is about a version-23 QR (111 modules with
  the margin), about 3.5 pixels per module at 640×480. On a phone, 480p
  (640×480) and 720p read about the same; 480p uses slightly less energy, so
  the receiver keeps asking phones for 640×480 (`preferLowRes`) while the
  QRs stay this size. 720p is an option if larger QRs pay off (see block size
  below).

Skipped: comparing chunks read per second on a real phone against the commit
before these changes (`2c7cafe`). The changes above were measured only in
headless Chrome with simulated slowness.

A phone camera delivers about 30 frames per second, so the receiver cannot
read more than about 30 QR codes per second. Above that, the sender's frames
are missed whatever the scanner does.

## QR codes the sender shows

Reading the QR codes, not fountain decoding, is what limits a transfer now, so
the codes themselves come next. Throughput is bytes per QR times QRs read per
second. The finished screen shows the time from the first chunk and the
chunks read per second; multiply by the block size for bytes per second.
Measure each change on a phone at 480p, or at 720p for the larger blocks
below.

- **Sender frame rate.** When the screen changes QR while the camera is
  capturing a frame, that frame shows a blend of two codes and does not
  decode. At 25–30 fps against a 30 fps camera many frames are blended; at
  about 15 fps each QR is up for two camera frames, so one is usually clean,
  and the receiver drops the repeat. Find the rate between about 15 and 30 fps
  that reads the most chunks per second. This needs no code: use the sender's
  frame-rate slider (default 25).
- **Block size, and so QR size.** Each QR carries one 1,000-byte block: a
  version-23 QR, about 3.5 pixels per module at 480p with the QR 384 pixels
  tall. A 750-byte block is version 19 (about 4.0), and a 500-byte block
  version 15–16 (about 4.6–4.9). Smaller QRs should read more reliably,
  especially farther away, but carry less: 500 bytes only wins if 1,000-byte
  QRs fail on more than half their frames.

  Larger blocks carry more per QR but need more pixels per module than 480p
  gives, so they go with asking the camera for 720p, which read about as well
  as 480p on a phone:

  | Block size | QR version | Pixels per module at 480p | At 720p |
  |---|---|---|---|
  | 1,000 bytes (now) | 23 | 3.5 | 5.2 |
  | 1,250 bytes | 26 | 3.1 | 4.7 |
  | 1,500 bytes | 28 | 2.9 | 4.4 |

  (With the QR 80% of the frame's height: 384 pixels at 480p, 576 at 720p.)
  At 720p, a 1,500-byte block has about the pixels per module a 500-byte block
  has at 480p, with three times the data. Each decode at 720p takes about 1.4×
  as long, which the two decoding workers should absorb, and the camera uses a
  little more energy. Blocks much above 1,500 bytes would exceed the sender's
  QR capacity limit (`getQRCapacity('L')`, 1,771 bytes with the chunk header).

  The block size is fixed at `DEFAULT_BLOCK_SIZE` (1,000), and
  `FountainQRSender` stops with an error if the encoder's differs, so trying
  other sizes needs that made configurable. The receiver already takes the
  block size from the metadata; asking for 720p means changing `preferLowRes`
  in `FountainQRDataScanner`.
- **Rendering on the sender's screen.** Draw each module as a whole number of
  screen pixels with no smoothing (`image-rendering: pixelated`), pure black on
  white, and with a wider margin than 1 module (the QR standard asks for 4); a
  1-module margin can fail against darker surroundings. These cost no
  throughput.
- **Per-chunk overhead.** Each chunk lists its block indices, 2 bytes each.
  Rebuilding them from the seed, as standard LT codes do, would save about
  1–2% of each QR. This changes the chunk format and the fountain decoder, so
  it goes with the decoding work below.

Already right: error correction L, since the fountain code already recovers
lost chunks, so the QR only has to correct errors within a frame; and raw
byte mode, with no text encoding overhead.

## Later

- Optimise the fountain decoding itself (`wasm/fountain` and
  `src/workers/fountainDecoder.worker.ts`), after the QR codes above: the
  decoder is not what limits a transfer now.
