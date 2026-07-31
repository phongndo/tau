# Mux Invariants (Phase 2.1)

Authoritative rules for Tau's mux graph and session lifecycle.
Encode these in constructors and mutation functions, not UI assumptions.

## Identity

1. **Session identity is independent from pane identity.**
   A pane references at most one session; a session may outlive every pane.
2. **IDs are opaque, stable, never positional, and never silently reused.**
   Prefer UUID-backed strings (`tab-…`, `pane-…`, `session-…`, `term-…`).
3. **Closing a pane and terminating a session are distinct operations.**
   Pane close detaches UI; session kill/terminate is explicit.
4. **Renderer disconnect never implies session termination.**
   `taud` keeps live PTYs across Electron restarts when detach policy allows.

## Graph structure

5. **Every pane belongs to exactly one valid pane tree** rooted at a tab.
6. **Every split has exactly two or more valid children and a bounded ratio.**
   Ratios are positive, sum to 100, each child ≥ 5% after normalize.
7. **Every graph mutation increments a monotonic revision** (`graphRev`).
8. **Every emitted event has a monotonic sequence** (`eventSeq`) per daemon instance.
9. **Unknown future/extension pane metadata is kept lossless** in opaque bags;
   core only requires `type: "terminal"` until the extension pane contract exists.

## I/O and resources

10. **Authoritative PTY input and output are never silently dropped** in `taud`.
11. **Resource use is bounded per session and per client**
    (pending frames/bytes, subscribers, control request size, queue age).
12. **When a renderer lags past budget**, recover with a complete current-screen
    snapshot and resume after its sequence — never splice mid UTF-8/CSI.

## Ownership and concurrency

13. **`taud` is the authority** for sessions and (Phase 2) the tab/pane graph.
14. **Renderer state is a subscribed projection**, never the mutation authority
    once graph RPCs land.
15. **Conflicting mutations use expected-revision**: mismatch → reject + snapshot.
16. **Multiple clients** may observe the same graph; writes are serialized in `taud`.

## Lifecycle vocabulary

| Verb | Meaning |
| --- | --- |
| detach | Stop delivering to a client; session stays live |
| terminate / kill | End the child process |
| archive | Persist exited/crashed session for later inspect/resume policy |
| forget | Remove metadata after terminate/archive cleanup |
| clear-history | Drop event log / scrollback per persistence policy |

## Multi-attach

One session **may** attach to multiple panes/clients (read fan-out).
Input is accepted from any attached controller; last-resize-wins with seq ordering.
Core UI currently uses 1:1 pane↔session; multi-attach remains a daemon capability.
