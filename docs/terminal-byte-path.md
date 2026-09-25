# Terminal byte path and memory ownership

## Output

```text
PTY master read (taud, Zig)
  -> persistent event log + binary TASF stream frame
  -> Unix socket -> TaudClient stream parser (Electron main)
  -> TaudPtyBridge: exact-sized owned copy -> per-session MessagePortMain
  -> preload: binary frame dispatch (bounded startup buffer if nobody subscribes)
  -> contextBridge callback -> renderer-owned Uint8Array
  -> sequenced writer: bounded batches of complete frames -> Ghostty WASM VT parser
  -> successful parse callback -> acknowledge highest applied sequence -> main releases backlog
  -> Tau canvas renders Ghostty render-state frames on requestAnimationFrame
```

Each daemon output frame is one PTY read with its own sequence number. During a sustained burst (reads less than 2 ms apart that have already produced 8 KiB) the reader keeps reading for up to about a millisecond before publishing, so many small producer writes share one event-log frame, sequence number and stream frame instead of tripping main's unacknowledged-frame bound. The first read after idle, and the first read after terminal input, publish immediately. The search excerpt grows to twice its 1 MiB budget before being compacted to its newest 1 MiB, rather than being reread on every PTY read.

Main validates each stream frame's CRC with native `zlib.crc32` and makes one exact-sized copy of the payload out of the parser's pending bytes; the socket chunk itself is not copied again before parsing.

The write callback confirms Ghostty parser application, **not** physical display presentation. A failed parse triggers a new WASM terminal and daemon snapshot resynchronization; the writer retains a bounded later-output suffix until a snapshot applies, dropping it only if the queue limit is exceeded. A stale snapshot cannot advance the acknowledgement cursor past missing frames. The native daemon and browser build share the revision in [`scripts/ghostty-source.ts`](../scripts/ghostty-source.ts). The WASM build applies narrow, verified browser-only patches for inline Kitty graphics (no host file access); `taud` uses the same upstream C ABI without those patches.

## Ownership and allocation rules

- Main copies socket payloads into exact-sized buffers before posting. This avoids exposing unrelated bytes or retaining an entire pooled socket allocation. Electron's `MessagePortMain` clones byte buffers; its transfer list is for MessagePorts. Do not pass ArrayBuffers in that transfer list.
- The renderer receives private bytes through `contextBridge`. Production uses `writeOwned` to hand them to the writer; callers must not reuse/mutate handed-off bytes. `write` still snapshots borrowed input. Small views are copied even on the owned path so they cannot pin oversized backing buffers.
- Before either a binary or text subscriber exists, preload retains one shared startup-byte queue, bounded to 1 MiB per session. Overflow clears it and requests a sequence-aware resync. Subscribing consumes and removes that queue. There is no second text-history buffer.
- `onPtyData` is compatibility-only. A text decoder exists only while a session has text subscribers and decodes with `stream: true`. It is released on the last unsubscribe or session cleanup. Late text subscribers receive unconsumed startup bytes, not a duplicate history of output already delivered to binary subscribers. Normal binary sessions perform no compatibility text decoding.
- The writer checks its 4 MiB queued-byte bound before allocating. Overflow discards queued presentation frames and requests a snapshot; it does not acknowledge discarded frames. One outstanding Ghostty write is additional to that queue budget.
- Already-queued complete frames are coalesced into at most 64 KiB / 128-frame batches. A single larger frame stays intact. An isolated owned frame incurs no writer byte-buffer copy. Multi-frame batches allocate one aggregate buffer. This reduces buffer-object churn, write callbacks and acknowledgements; it does not make copying of batched bytes disappear.
- Consumed queue entries are cleared immediately. The queue uses a cursor with periodic in-place compaction rather than shifting every frame. Snapshot filtering compacts in place, and disposing clears queued ownership and ignores late parse callbacks.
- Acknowledgement occurs only after the whole batch is applied. The writer processes one batch per task and yields between batches with Chromium's `scheduler.postTask` (`setTimeout` where that API is absent, as in unit tests). Nested `setTimeout(0)` is clamped to 4 ms, which had capped a pane at roughly 16 MiB/s and made a keystroke echo wait behind the queued window; input keeps its higher scheduler priority. For one second after input in a pane, other panes' batches are posted at `background` priority while that pane stays at `user-visible`, so its echo is not queued behind other panes' floods; nothing is raised above rendering or input. The writer does not wait for more frames just to fill a batch. The existing snapshot recovery path and main's byte/frame backlog bounds remain in place.

## Rendering

`TauTerminal` draws at most once per animation frame, and only rows Ghostty reports dirty (plus cursor rows; everything on a resize, full-dirty frame or image change). Selection changes, scrolling and screen switches arrive from Ghostty as full-dirty frames, so the surface does not force its own full repaints. Cell extraction reuses one `DataView` until WASM memory grows, decodes packed cells without BigInt, interns color strings, and resolves each style id once per row (style ids are page-local; a row belongs to one page). The accessible viewport text is recomputed only for painted rows and written to the DOM only when it changes. Runs of letters, digits and spaces sharing color, weight and faintness are drawn with one `fillText` when the font's advance for those characters equals the cell width (checked per font variant; otherwise cells are drawn individually). Punctuation stays per cell because canvas cannot disable coding-font ligatures, and kerning is off; the surface test requires pixel-identical output against per-cell drawing.

A pane whose canvas cannot show one cell (a parked hidden tab, or a collapsed layout) keeps parsing and acknowledging output but skips render-state reads and painting, and releases its canvas backing store. Ghostty's dirty state accumulates meanwhile; the first visible draw marks the render state fully dirty and re-reads every row, so a restored pane shows current output.

## Reload and port teardown

An attach belongs to its control port, session channel, and attach generation. Closing or replacing
those ports revokes that ownership and closes the subscriber stream. An attach RPC that completes
later closes its own returned stream; it cannot overwrite the replacement renderer's stream or
publish stale ready/error events. Stream events and queued port messages are likewise checked
against their current owner. Cancellation is an expected boundary; failures for the current owner
still propagate. Reload recovery continues to use a fresh daemon snapshot, not a retained text copy.

## Input

```text
Tau terminal keyboard/mouse/paste encoders and Ghostty PTY-response callback (renderer)
  -> contextBridge API with primitive string + encoding
  -> preload's reusable TextEncoder (or binary-byte conversion)
  -> session MessagePort: cloned input buffer
  -> main bridge -> TaudClient input frame -> Unix socket -> taud -> PTY
```

Input bypasses the output batching queue. Keep context isolation, sandboxing, and sender-bound channels; removing those boundaries is not an allocation optimization.

## Verification

`bun run test:persistence` covers the real preload dispatch using a mocked Electron transport, decoder lifetime/UTF-8 boundaries, startup buffering and overflow, mixed subscribers, writer ownership, batch ordering, acknowledgements, snapshot filtering, and disposal. The package smoke tests exercise actual Electron IPC; unit tests do not model contextBridge serialization costs.

Surface correctness: `bun run test:surface` bundles the actual `TauTerminal` into a sandboxed Electron renderer with the packaged Ghostty WASM. It needs a display (`DISPLAY` on Linux); for a headless Linux host, run under Xvfb (for example `Xvfb :97 -screen 0 1280x800x24 &` followed by `DISPLAY=:97 nix develop -c bun run test:surface`, then stop Xvfb). CI runs this separately under Xvfb. Its browser checks exercise canvas pixels, accessible viewport text, Unicode, erase/SGR, alternate screen, resize, search, keyboard/IME/paste, title/PTY/clipboard effects, synchronized output, links, actual pointer selection and mouse reporting, scrollback, Kitty image pixels, reset and disposal. It uses an in-process HTTP fixture and a mocked `electronAPI`, not the packaged preload or daemon; it does not assert font-identical screenshots, platform IME behavior, all VT sequences, or hardware GPU composition. Keep it separate from `bun run test` so headless unit checks do not silently depend on a display. Manual review on the actual supported display/OS is still required for appearance and platform input behavior.

For performance work distinguish:

- Decoder/buffer construction counts and retained queue bytes: deterministic allocation probes.
- Writer + Ghostty throughput: isolate the writer with the packaged Ghostty WASM and byte workload, and check final screen content. `bun run bench:surface` does this for the production `TauTerminal` surface (parse, render-state extraction and canvas-command timings, frame cadence, input dispatch and echo-drawn latency under flood, hidden panes, idle, create/close memory) and can alternate against another source tree; see the header of [`surface-benchmark.ts`](../apps/desktop/bench/surface-benchmark.ts). `bench:terminal` and `bench:renderer` measure an xterm.js harness, not Tau's surface.
- Packaged input/output smoke: checks transport and counters, not full terminal presentation throughput.
- Frame presentation, idle CPU and RSS: use a real display/GPU; Xvfb does not establish hardware rendering performance. The benchmark commands and enforced smoke thresholds live in the root and desktop `package.json` files.
