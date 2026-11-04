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

Still to do, both of which need a real phone; a synthetic test would only
measure the blur and noise it assumed:

- **Check the camera resolution against the QR size.** A 1 KB fountain chunk
  is a version-26 QR (121 modules). Phones ask for 640×480 (`preferLowRes`),
  about 3 pixels per module, which is at the edge for real camera images;
  desktop asks for nothing and usually gets 640×480 too. 1280×720 costs about
  1.4× the decode time; measure on a phone whether fewer failed reads make up
  for it.
- **Measure on a real phone.** Count chunks read per second, from a sender at
  25 fps and higher, against the commit before these changes.

A phone camera delivers about 30 frames per second, so the receiver cannot
read more than about 30 QR codes per second. Above that, the sender's frames
are missed whatever the scanner does.

## Later

- Optimise the fountain decoding itself (`wasm/fountain` and
  `src/workers/fountainDecoder.worker.ts`).
