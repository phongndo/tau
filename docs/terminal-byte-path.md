# Terminal byte path and memory ownership

## Output

```text
PTY master read (taud, Zig)
  -> persistent event log + binary TASF stream frame
  -> Unix socket -> TaudClient stream parser (Electron main)
  -> TaudPtyBridge: exact-sized owned copy -> per-session MessagePortMain
  -> preload: binary frame dispatch (bounded startup buffer if nobody subscribes)
  -> contextBridge callback -> renderer-owned Uint8Array
  -> sequenced writer: bounded batches of complete frames -> xterm.write(bytes)
  -> xterm callback -> acknowledge highest applied sequence -> main releases backlog
  -> xterm WebGL/default renderer presents the terminal
```

An xterm write callback confirms parser application, **not** physical display presentation.

## Ownership and allocation rules

- Main copies socket payloads into exact-sized buffers before posting. This avoids exposing unrelated bytes or retaining an entire pooled socket allocation. Electron's `MessagePortMain` clones byte buffers; its transfer list is for MessagePorts. Do not pass ArrayBuffers in that transfer list.
- The renderer receives private bytes through `contextBridge`. Production uses `writeOwned` to hand them to the writer; callers must not reuse/mutate handed-off bytes. `write` still snapshots borrowed input. Small views are copied even on the owned path so they cannot pin oversized backing buffers.
- Before either a binary or text subscriber exists, preload retains one shared startup-byte queue, bounded to 1 MiB per session. Overflow clears it and requests a sequence-aware resync. Subscribing consumes and removes that queue. There is no second text-history buffer.
- `onPtyData` is compatibility-only. A text decoder exists only while a session has text subscribers and decodes with `stream: true`. It is released on the last unsubscribe or session cleanup. Late text subscribers receive unconsumed startup bytes, not a duplicate history of output already delivered to binary subscribers. Normal binary sessions perform no compatibility text decoding.
- The writer checks its 4 MiB queued-byte bound before allocating. Overflow discards queued presentation frames and requests a snapshot; it does not acknowledge discarded frames. One outstanding xterm write is additional to that queue budget.
- Already-queued complete frames are coalesced into at most 64 KiB / 128-frame batches. A single larger frame stays intact. An isolated owned frame incurs no writer byte-buffer copy. Multi-frame batches allocate one aggregate buffer. This reduces buffer-object churn, write callbacks and acknowledgements; it does not make copying of batched bytes disappear.
- Consumed queue entries are cleared immediately. The queue uses a cursor with periodic in-place compaction rather than shifting every frame. Snapshot filtering compacts in place, and disposing clears queued ownership and ignores late xterm callbacks.
- Acknowledgement occurs only after the whole batch is applied. The writer yields between batches using a task; it does not wait for more frames just to fill a batch. The existing snapshot recovery path and main's byte/frame backlog bounds remain in place.

## Reload and port teardown

An attach belongs to its control port, session channel, and attach generation. Closing or replacing
those ports revokes that ownership and closes the subscriber stream. An attach RPC that completes
later closes its own returned stream; it cannot overwrite the replacement renderer's stream or
publish stale ready/error events. Stream events and queued port messages are likewise checked
against their current owner. Cancellation is an expected boundary; failures for the current owner
still propagate. Reload recovery continues to use a fresh daemon snapshot, not a retained text copy.

## Input

```text
xterm onData/onBinary (renderer)
  -> contextBridge API with primitive string + encoding
  -> preload's reusable TextEncoder (or binary-byte conversion)
  -> session MessagePort: cloned input buffer
  -> main bridge -> TaudClient input frame -> Unix socket -> taud -> PTY
```

Input bypasses the output batching queue. Keep context isolation, sandboxing, and sender-bound channels; removing those boundaries is not an allocation optimization.

## Verification

`bun run test:persistence` covers the real preload dispatch using a mocked Electron transport, decoder lifetime/UTF-8 boundaries, startup buffering and overflow, mixed subscribers, writer ownership, batch ordering, acknowledgements, snapshot filtering, and disposal. The package smoke tests exercise actual Electron IPC; unit tests do not model contextBridge serialization costs.

For performance work distinguish:

- Decoder/buffer construction counts and retained queue bytes: deterministic allocation probes.
- Writer + xterm throughput: isolate the writer with the same Electron/xterm versions and byte workload, and check final screen content.
- Packaged input/output smoke: checks transport and counters, not full terminal presentation throughput.
- Frame presentation, idle CPU and RSS: use a real display/GPU; Xvfb does not establish hardware rendering performance. The benchmark commands and enforced smoke thresholds live in the root and desktop `package.json` files.
