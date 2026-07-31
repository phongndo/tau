# Terminal Byte Path Inventory (Phase 1.7)

Documented before Phase 2.4 fast-lane redesign. Trace markers should land at each hop.

## Current path (output)

```text
PTY master read (taud, Zig)
  -> session pending buffer / event log append
  -> stream frame encode (TASF binary: magic, kind=output, sessionId, seq, crc, payload)
  -> Unix socket write to Electron main
  -> TaudClient stream parser (main)
  -> TaudPtyBridge MessagePort postMessage
       payload currently decoded to JS string via StringDecoder
  -> preload MessagePort onmessage
       schema-decode PtyServiceMessage
       duplicate dispatch: handleSessionOutput + handlePtyData
  -> renderer terminal.ts onSessionOutput callback
       optional startup buffer, then BatchedTerminalWriter
  -> xterm.write(string)
  -> WebGL/canvas refresh
```

## Current path (input)

```text
xterm onData (renderer)
  -> electronAPI.writeSessionInput(sessionId, Uint8Array)  OR sendPtyInput(string)
  -> preload queuePtyMessage({ type: 'write', data })
  -> MessagePort to main bridge
  -> TaudClient stream input frame
  -> Unix socket
  -> taud parse input frame
  -> write to PTY master
```

## Allocations / copies / hops (inventory)

| Hop | Allocation / copy | Notes |
| --- | --- | --- |
| PTY read | kernel -> user buffer | daemon owned |
| Event log append | file write | durable |
| Stream encode | header + payload copy into socket buffer | binary, good |
| Main parse | Buffer slices; string decode for text | **string copy** |
| MessagePort | structured clone of string (or transfer if ArrayBuffer) | currently string |
| Preload | schema validation per message | control-plane cost on data path |
| Dual dispatch | two callback maps | **duplicate** handleSessionOutput + handlePtyData |
| Startup buffer | string frames in array | bounded |
| xterm write | JS string into parser | wants bytes where possible |

## Phase 1 cleanups applied

- Prefer `onSessionOutput` only in production terminal path; leave `onPtyData` for benchmarks/compat without dual write into xterm.
- Do not buffer pending data/output for channels with zero subscribers beyond a small bound; drop-with-counter only when no subscriber will ever attach (detach clears state).
- Stop requiring workspace/worktree IDs on create/attach.
- Trace markers: `daemon:read`, `main:stream-frame`, `renderer:output`, `xterm:write-complete` (see `trace.ts` / daemon logs).

## Phase 2 redesign targets

- Dedicated MessagePort per visible session
- Transfer `ArrayBuffer`/`Uint8Array`, not cloned strings
- Validate session/channel setup once; no per-chunk schema decode
- Binary snapshots (no base64)
- Renderer ack of applied output seq; snapshot resync on lag
- Authoritative layer never drops; presentation may skip obsolete frames explicitly
