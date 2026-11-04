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

Still to do:

- **Decode in more than one worker.** If decoding on phones is slower than the
  camera's frame rate, two workers taking turns would use a second core.
- **Check the camera resolution against the QR size.** A 1 KB fountain chunk
  is a version-26 QR (121 modules). Phones ask for 640×480 (`preferLowRes`),
  about 3 pixels per module, which is at the edge for real camera images;
  desktop asks for nothing and usually gets 640×480 too. 1280×720 costs about
  1.4× the decode time; measure on a phone whether fewer failed reads make up
  for it.
- **Drop repeated reads in the scanner.** The scanner reads the same QR across
  several camera frames and forwards every read to the decoder worker. Skip a
  read whose bytes match the previous one. The existing `debounceMs` cannot do
  this as it stands: `handleBinaryFountainChunk` transfers the bytes' buffer to
  the decoder worker, which empties the copy kept in `lastScannedRef`.
- **Remove per-frame logging.** `FountainQRDataScanner` logs two or three lines
  per read, and `FountainQRReceiver` logs an object per chunk.
- **Measure on a real phone.** Count chunks read per second, from a sender at
  25 fps and higher, before and after each change above.

A phone camera delivers about 30 frames per second, so the receiver cannot
read more than about 30 QR codes per second. Above that, the sender's frames
are missed whatever the scanner does.

## Later

- Optimise the fountain decoding itself (`wasm/fountain` and
  `src/workers/fountainDecoder.worker.ts`).
