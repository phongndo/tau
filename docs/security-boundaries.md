# Security Boundaries (Phase 2.7–2.9)

## Daemon lifecycle

- Single-owner socket + PID file under private Tau storage (`0700` dirs, `0600` files, `0600`/`0700` socket).
- Stale socket/PID cleared only after liveness probe fails.
- Prefer `getpeereid` / `SO_PEERCRED` peer checks where the OS supports them.
- Handshake returns protocol version, capabilities, daemon version, build id; incompatible clients are rejected without killing sessions.
- Restart/replace/reuse/detach are idempotent.

## Protocol

- Control plane: NDJSON requests with max frame size, argv length, env/path/title/metadata bounds.
- Data plane: TASF binary frames; no per-chunk control schema validation on the hot path after channel setup.
- Structured error codes; no secret/env leakage in logs, snapshots, or diagnostics.
- Argv arrays only — never shell-string interpolation of untrusted input.
- cwd normalized and validated without silently broadening access.
- Malformed frames rejected; unrelated sessions stay alive.
- Fuzz targets: control decode, stream parse, graph mutation, persistence recovery.

## Electron client

- `contextIsolation: true`
- `nodeIntegration: false`
- Renderer sandbox enabled when measured features allow (currently false while preload needs clipboard/shell; track enabling)
- Restrictive CSP on all renderer responses
- Minimal preload API (sessions, layout, settings, diagnostics, app commands)
- No filesystem/process/socket primitives exposed to renderer
- Validate control responses before applying UI state
- Trust, permission, recovery, diagnostics UI remain core-owned

## Resource bounds

- Per-session pending output frames/bytes
- Per-client control rate and outstanding requests
- Global session count ceiling in `limits.zig`
