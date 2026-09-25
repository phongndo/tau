# Terminal byte path and memory ownership

## Output

```text
PTY master read (taud, Zig)
  -> persistent event log + binary TASF stream frame
  -> Unix socket -> TaudClient stream parser (Electron main): native CRC-32, exact-sized payload copy
  -> TaudPtyBridge: posts that exact buffer (Electron clones it) -> per-session MessagePortMain
  -> preload: binary frame dispatch (bounded startup buffer if nobody subscribes)
  -> contextBridge callback -> renderer-owned Uint8Array
  -> sequenced writer: bounded batches of complete frames -> Ghostty WASM VT parser
  -> successful parse callback -> acknowledge highest applied sequence -> main releases backlog
  -> Tau canvas renders Ghostty render-state frames on requestAnimationFrame (visible panes only)
```

The write callback confirms Ghostty parser application, **not** physical display presentation. A failed parse triggers a new WASM terminal and daemon snapshot resynchronization; the writer retains a bounded later-output suffix until a snapshot applies, dropping it only if the queue limit is exceeded. A stale snapshot cannot advance the acknowledgement cursor past missing frames. The native daemon and browser build share the revision in [`scripts/ghostty-source.ts`](../scripts/ghostty-source.ts). The WASM build applies narrow, verified browser-only patches for inline Kitty graphics (no host file access); `taud` uses the same upstream C ABI without those patches.

## Ownership and allocation rules

- Main posts only exact-sized buffers: posting clones the whole `ArrayBuffer`, so a view would expose unrelated bytes. The stream parser copies each payload into its own exact-sized buffer (`Buffer.from` would return a view into Node's shared pool, 64 KiB slabs in Electron), and the bridge posts it without a second copy; any other view is copied first. The parser reads a lone socket chunk in place and copies only an incomplete-frame remainder, so it never retains a view into a caller's buffer. Electron's `MessagePortMain` clones byte buffers; its transfer list is for MessagePorts. Do not pass ArrayBuffers in that transfer list.
- The renderer receives private bytes through `contextBridge`. Production uses `writeOwned` to hand them to the writer; callers must not reuse/mutate handed-off bytes. `write` still snapshots borrowed input. Small views are copied even on the owned path so they cannot pin oversized backing buffers.
- Before either a binary or text subscriber exists, preload retains one shared startup-byte queue, bounded to 1 MiB per session. Overflow clears it and requests a sequence-aware resync. Subscribing consumes and removes that queue. There is no second text-history buffer.
- `onPtyData` is compatibility-only. A text decoder exists only while a session has text subscribers and decodes with `stream: true`. It is released on the last unsubscribe or session cleanup. Late text subscribers receive unconsumed startup bytes, not a duplicate history of output already delivered to binary subscribers. Normal binary sessions perform no compatibility text decoding.
- The writer checks its 4 MiB queued-byte bound before allocating. Overflow discards queued presentation frames and requests a snapshot; it does not acknowledge discarded frames. One outstanding Ghostty write is additional to that queue budget.
- Already-queued complete frames are coalesced into at most 64 KiB / 128-frame batches. A single larger frame stays intact. An isolated owned frame incurs no writer byte-buffer copy. Multi-frame batches allocate one aggregate buffer. This reduces buffer-object churn, write callbacks and acknowledgements; it does not make copying of batched bytes disappear.
- Consumed queue entries are cleared immediately. The queue uses a cursor with periodic in-place compaction rather than shifting every frame. Snapshot filtering compacts in place, and disposing clears queued ownership and ignores late parse callbacks.
- Acknowledgement occurs only after the whole batch is applied. The writer yields between batches using a task; it does not wait for more frames just to fill a batch. Visible panes yield with a `MessageChannel` task: browsers clamp `setTimeout(0)` chained from timer callbacks to at least 4 ms after five levels, which capped parsing at one batch per 4 ms. Hidden panes keep the timer yield so they cannot crowd out visible output. Input and rendering tasks outrank both. The existing snapshot recovery path and main's byte/frame backlog bounds remain in place.
- Hidden runtimes are parked in a 1x1 off-screen container. They keep parsing and acknowledging output, but `TauTerminal` skips decoding and painting until the surface is visible again; Ghostty's dirty rows accumulate until the next render, and reattaching repaints what changed. Row decoding reuses one `DataView` and resolves each style ID once per row.

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
- Writer + Ghostty throughput: isolate the writer with the packaged Ghostty WASM and byte workload, and check final screen content.
- Packaged input/output smoke: checks transport and counters, not full terminal presentation throughput.
- Production surface work: `bun run bench:surface` drives `TauTerminal`, the sequenced writer and packaged WASM with flow-controlled synthetic frames (visible, multi-pane, parked, progress-line, idle, create/close) and fails on dropped or missing output. It times parse acknowledgement and `requestAnimationFrame` draw callbacks, not compositor rasterization or presentation. `bench:terminal`/`bench:renderer` measure an xterm.js harness, not Tau's surface.
- Frame presentation, idle CPU and RSS: use a real display/GPU; Xvfb does not establish hardware rendering performance. The benchmark commands and enforced smoke thresholds live in the root and desktop `package.json` files.
