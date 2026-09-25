# Surface and transport efficiency pass — 2026-09-25

Baseline `78436a4021a1131a31a85f7f67cc9edb387e5009`; candidate is the commit adding this report. Dependencies, `bun.lock` (`844587005bc9…c7791304`) and the Ghostty WASM (`673c8178bc5d…d6c39c5`, `622b4eec…/tau-browser-graphics-v1`) are unchanged. Implemented behavior is described in [terminal byte path](../terminal-byte-path.md).

## Environment and boundaries

- Host `z`: NixOS, Linux 6.18.48, AMD Ryzen 9 9950X (32 threads). Commands ran through `nix develop` (Bun 1.4.2, Node 24.15.0, Zig 0.16.0). Electron 44.4.5: Chromium 152.0.7977.130, Node 24.21.0, V8 15.2.
- Display: Xvfb 1280×800×24 **without GLX**. Chromium's GPU process exits; canvas and rasterization report `disabled_software`. Nothing here measures GPU rasterization, compositing or physical presentation. No real-display run was possible on this host.
- Baseline and candidate were separate worktrees built from the same lockfile, measured in alternating order.

Surface timing boundaries (`bun run bench:surface`): `parse` = `GhosttyVt.write`; `render` = render-state extraction; `draw` = extraction plus canvas commands. "Presented" means an animation frame ran after the draw that follows the final acknowledgement. `echoDrawn` is from the keydown event's timestamp to the end of the draw after the echo frame was parsed. The echo is injected behind output already inside main's 4 MiB / 512-frame unacknowledged window. This harness uses the real surface, writer and WASM with MessagePort-task delivery. It does not use preload, contextBridge or the daemon.

## Surface (Ghostty/TauTerminal, headless Xvfb)

Medians of 5 alternating rounds. That run's candidate still cached a compiled WASM module (rejected below), which affects only pane creation, outside these measurement windows. The pane is 99×42 cells (1200×760 CSS px, DPR 1), except `-4` scenarios, which use four panes in the same area.

| Scenario                                                |         Baseline |       Candidate |
| ------------------------------------------------------- | ---------------: | --------------: |
| flood-plain 16 MiB, presented                           |       1,347.6 ms |        100.2 ms |
| flood-sgr 8 MiB, presented                              |         948.3 ms |        150.4 ms |
| flood-unicode 4 MiB, presented                          |         542.8 ms |         93.6 ms |
| flood-sgr-4 (4 × 4 MiB), presented                      |         650.3 ms |        301.1 ms |
| flood-sgr: render-state extraction, total               |         157.9 ms |          4.9 ms |
| flood-sgr: draw p95                                     |           6.9 ms |          2.7 ms |
| Full-screen TUI at one screen per frame: draw p50 / p95 |     5.7 / 7.7 ms |    2.0 / 2.7 ms |
| Key dispatch delay p95 under flood, 1 / 4 panes         |     6.0 / 7.5 ms |    3.2 / 4.1 ms |
| Echo drawn p50 under flood, 1 / 4 panes                 |   257.5 / 293 ms | 47.2 / 151.2 ms |
| Echo drawn p95 under flood, 1 / 4 panes                 | 294.1 / 322.8 ms | 61.2 / 185.2 ms |
| Hidden panes: renders of 3 parked panes                 |              102 |               0 |
| Idle 3 s, 4 panes: rAF requests / draws                 |            0 / 0 |           0 / 0 |

Raw presented samples, ms. flood-plain: baseline `[1301.7, 1281.7, 1351.1, 1347.6, 1349.3]`, candidate `[103, 99.3, 101.2, 99.1, 100.2]`. flood-sgr: `[916.7, 932.6, 950.6, 948.3, 1014.8]` / `[150.9, 150.4, 149.8, 150.1, 164.8]`. Echo drawn p50, 1 pane: `[252.3, 258.9, 249.8, 261.1, 257.5]` / `[42.9, 41.5, 47.2, 48.6, 50.7]`. There were no long tasks, and frame-interval p95 stayed at 16.7–16.8 ms in every scenario on both sides. Every flood checks the final accessible screen and zero resyncs. Hidden panes are reattached and must show output written while they were parked.

Most flood time was idle. Nested `setTimeout(0)` in the writer is clamped to 4 ms, so each 64 KiB batch waited about 4 ms (flood-plain spent 36 ms parsing out of 1.35 s). Removing that clamp is also what shortens echo latency: the echo waits behind a bounded byte window that now drains faster. With four panes the main thread is busy parsing all of them, so the echo still waits about 150 ms.

Startup and create/close use the final loader: bytes cached, WASM compiled per pane. Medians of 3: cold create plus first frame 26.1 ms baseline against 28.0 ms. Second-pane first frame 15.8 against 12.0 ms. Renderer RSS after 30 create/dispose cycles 129.6 against 129.1 MB. JS heap after GC 1.54 against 1.56 MB. Over 150 cycles, the baseline and the module-caching candidate grew +1.0 MB and +0.5 MB, so there is no per-pane leak.

### Allocation and CPU attribution

This was a separate run with the CDP sampling profilers (8 KiB heap sampling, collected objects included; 200 µs CPU sampling), one sample per side. The profilers perturb timing, so use these only for attribution.

| Scenario                        | Sampled allocation | GC time    | Top baseline site                                    |
| ------------------------------- | -----------------: | ---------- | ---------------------------------------------------- |
| flood-sgr                       |    330.2 → 6.1 MiB | 35 → 3 ms  | `readRow` 247.7 MiB                                  |
| Full-screen TUI, 180 frames     | 1,059.4 → 78.0 MiB | 89 → 10 ms | `readRow` 801.5 MiB; `view()` 262 ms CPU             |
| 4 panes, input under flood, 3 s |  829.6 → 110.2 MiB | 60 → 16 ms | `readRow` 627.7 MiB (candidate parsed ~2× the bytes) |

The baseline built a `DataView` for every memory read, a BigInt for every cell field and a hex string for every color. The candidate's largest remaining JS costs are per-cell `fillText` and upstream WASM parsing.

## Daemon, main parser and packaged transport

Three rounds, alternating, with managed `taud` under a temporary `HOME`.

| Measurement                                                     |             Baseline |            Candidate |
| --------------------------------------------------------------- | -------------------: | -------------------: |
| Idle echo round trip p50 / max (`latency-taud`, 60 samples)     | 0.03–0.04 / ≤0.43 ms | 0.03–0.04 / ≤0.44 ms |
| Echo under 8 MiB flood, p50 (`input-priority`)                  |         2.42–2.72 ms |         1.15–1.16 ms |
| Echo under 8 MiB flood, max                                     |         3.38–3.46 ms |         1.20–2.13 ms |
| Frames for 1 MiB of 64-byte writes                              |          2,375–2,660 |              232–262 |
| `taud` CPU, 2 × 16 MiB soak iterations (user + system)          |          3.68–3.77 s |          0.26–0.35 s |
| 16 MiB soak iteration                                           |       3,152–3,348 ms |       1,641–1,990 ms |
| Main parser, 16 MiB of stream frames (Node 24, micro-benchmark) |             46–47 ms |               8–9 ms |
| Packaged 8 MiB flood + input probe: duration                    |       1,524–1,555 ms |           182–186 ms |
| Packaged 8 MiB flood: renderer messages                         |          1,963–2,006 |              139–147 |
| Packaged 8 MiB flood: input echo                                |         12.4–18.0 ms |          5.3–16.3 ms |
| Packaged default smoke: renderer load / total                   |   95–97 / 217–219 ms |  96–102 / 220–228 ms |

The packaged flood path uses the real daemon, main bridge and preload, but its subscriber is the smoke script, not `TauTerminal`.

Every PTY read used to reread `excerpt.txt`, and once the file held 1 MiB, rewrite it too, while holding the daemon lock that input writes also take. That cost dominated daemon system time. Removing it has a side effect: with no per-read file I/O pacing the reader, each read picked up about one producer `write()`. 1 MiB of 64-byte writes became 16,229 frames, which tripped main's 512-frame backlog in `bench:taud:budget` on 5 of 5 runs. The retained change therefore coalesces reads inside a sustained burst (≥8 KiB already read, reads <2 ms apart; wait ≤ ~1 ms). The first read after idle or after input is never delayed. Echo under flood keeps about 1.1 ms of coalescing when the echoing program answers after its first read, as the benchmark's raw-mode echoer does. Kernel (cooked-mode) echo is in the first read after input.

## Validation

On the candidate: `bun run check` passed, including 113 persistence tests, the Zig tests and new excerpt, burst and OOM tests. `bun run build`, `zig:leak-check`, `test:surface` (40 checks, 6 new), `smoke:package` (plain, and with `TAU_ELECTRON_SMOKE_SURFACE=1 TAU_ELECTRON_SMOKE_IMAGE=1`) and `test:shell-lifecycle` passed. So did the latency, input-priority, attach, soak, taud, IPC, startup, reload and app-soak budgets, unchanged. `bench:taud:budget` passed 5/5 on the final daemon.

New regression coverage:

- A differential test compares cached cell extraction with an uncached, BigInt, per-cell reference over styles, >64 style ids, >4,096 colors, wide cells, graphemes and selection. Mutating the bitfield or color code fails it.
- `invalidate()` makes the next render report every row.
- The writer yields exactly one batch per task, cancels stale tasks, and prefers `scheduler.postTask`.
- Canvas pixels: the selection highlight appears and is cleared on the keypress that clears it. A plain click and a keystroke echo repaint only changed rows. A parked pane releases its canvas and shows current output when shown again.
- Native CRC equals CRC-32/IEEE and the portable implementation.
- The excerpt keeps its newest bytes, is bounded, and survives allocation failure at every point (`checkAllAllocationFailures`).
- `readBurst` behavior at the deadline, a full buffer and EOF, plus the burst decision.

## Rejected or not attempted

- **Cached compiled WASM module**: saved about 4.5 ms per additional pane or core reset, but retained about 2–5 MB more renderer RSS. Rejected.
- **Daemon excerpt fix without read coalescing**: echo under flood dropped to about 0.05 ms, but it multiplied frames about 6.5× and failed `bench:taud:budget` 5/5 via main backpressure. Replaced by the coalescing version above.
- **Coalescing that skips waiting for 50 ms after any input**: `bench:taud:budget` failed 5/5 on its post-input flood. **Coalescing without the volume threshold**: idle echo p50 rose from 0.03 to 1.11 ms. Both rejected.
- **Not attempted**: merging frames in main (it would coarsen sequence granularity against snapshot reconciliation); batching `fillText` runs (changes shaping and ligatures, unverifiable without the target display); prioritizing the focused pane's writer.

## Gaps and pre-existing issues

- No real-display or GPU measurement: frame cadence, presentation latency, idle CPU and GPU memory on hardware are unmeasured. Manual review on the supported display is still needed.
- `bun run test:taud-lifecycle` ("restarts an owned real daemon after process exit") fails identically on the baseline (3/3). It is not in `bun run check`, and this pass leaves it unchanged.
- On the baseline, one `bench:taud:budget` run out of 10 ended in a daemon `SIGSEGV` right after a slow-subscriber drop; recovery then timed out. It was not reproduced on the candidate (0/15 after coalescing), and it was not diagnosed. The drop/reattach path needs its own investigation.
- The echo latencies above include this host's scheduling. Treat them as bounded comparisons, not display guarantees.

## Reproduce

Under a display (for example `Xvfb :97 -screen 0 1280x800x24 &` and `DISPLAY=:97`), inside `nix develop`:

```bash
TAU_SURFACE_BENCH_SOURCES="baseline=/path/to/baseline/apps/desktop,candidate=$PWD/apps/desktop" \
  TAU_SURFACE_BENCH_ROUNDS=5 bun run bench:surface
TAU_SURFACE_BENCH_PROFILE=1 TAU_SURFACE_BENCH_ROUNDS=1 \
  TAU_SURFACE_BENCH_SCENARIOS=flood-sgr,tui-redraw,input-under-load-4 bun run bench:surface
TAUD_PATH=/path/to/taud bun run --filter @tau/desktop bench:input-priority:budget
TAUD_PATH=/path/to/taud TAU_SOAK_ITERATIONS=2 TAU_SOAK_BYTES=16777216 bun apps/desktop/bench/taud-soak-benchmark.ts
TAU_ELECTRON_SMOKE_OUTPUT_BYTES=8388608 TAU_ELECTRON_SMOKE_MAX_INPUT_ECHO_MS=500 \
  TAU_ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS=8000 bun run smoke:package
```

Daemon CPU was read from `/proc/<taud pid>/stat` (utime, stime) until the managed daemon exited. The 64-byte-write frame counts used a temporary copy of the soak benchmark with `chunk=b"0123456789abcdef"*4`. Raw JSON and logs were kept in session scratch space and are not part of the repository.

## Follow-up levers (same day)

These were measured against the pass above (`b93fdb9`), 3 alternating rounds, in the same environment. A second session was running its own Electron benchmarks on this host at the time (load average around 8 on 32 threads), so the rounds alternated sources and only differences that repeated are claimed.

The glyph-run numbers used a temporary fontconfig exposing DejaVu Sans Mono. The earlier results used the only font Electron found here, the proportional DejaVu Sans, which disables runs by design.

| Scenario (medians)                              |             Pass | Priority + glyph runs |
| ----------------------------------------------- | ---------------: | --------------------: |
| Echo drawn p50 / p95, 4 panes flooding          | 145.4 / 150.8 ms |        43.6 / 50.4 ms |
| Key dispatch p95, 1 / 4 panes under flood       |     2.8 / 3.2 ms |          1.7 / 0.9 ms |
| Full-screen TUI draw p50 / p95                  |     2.3 / 3.0 ms |          1.0 / 1.4 ms |
| flood-plain presented                           |         103.4 ms |               88.1 ms |
| Frame-interval p95, idle work, create/close RSS |        unchanged |             unchanged |

- **Input priority** (`perf/lever-priority`). The first variant raised the typed-in pane to `user-blocking`. It cut the 4-pane echo to 51 ms, but frame-interval p95 doubled to 33.4 ms, so it was rejected. The retained variant lowers the other panes to `background` instead. The trade-off: while you type continuously, other flooding panes parsed about 6× less (10.8 against 63 MB over the window). In the app, that can push them into main's existing backlog/snapshot-resync path; it is bounded to 1 s after the last input.
- **Glyph runs** (`perf/lever-textruns`). A first version set `textRendering: optimizeSpeed`. That changes glyph advances in Chromium and shifted the cell grid, so it was dropped.
- **Worker per pane** (`perf/lever-worker`, spike, not production-complete). The VT core and an OffscreenCanvas painter move into a dedicated worker. The page compiles the WASM module once and shares it. The writer and its acknowledgement order are unchanged.

  | Measurement                                 |         Pass | Worker spike |
  | ------------------------------------------- | -----------: | -----------: |
  | flood-sgr-4 presented                       |     270.5 ms |      86.4 ms |
  | Output parsed in 3.5 s, 4 panes under input |       243 MB |       966 MB |
  | Echo drawn p50, 4 panes                     |     145.6 ms |      43.8 ms |
  | Key dispatch p95, 1 pane                    |       2.3 ms |       0.3 ms |
  | Additional pane first frame                 |      15.7 ms |       6.9 ms |
  | Renderer RSS, 1 / 4 panes                   | 165 / 164 MB | 182 / 201 MB |

  An early version leaked about 3.7 MB of renderer RSS per closed pane: a retained facade pinned the placeholder canvas and its last frame. After fixing that, 60 cycles grew 6.6 MB, but a small facade object is still retained. Open gaps before this could ship:
  - OSC 52 clipboard writes are denied, because confirmation lives on the page.
  - A failed parse is reported but not recovered.
  - Key encoding is asynchronous, so the default action is prevented for every non-modifier key, and kitty report-all modifier keys and double-click selection are not ported.
  - There is no Vite/CSP worker packaging, and the surface test suite is not ported.

- **WebGL glyph atlas: not measurable here.** WebGL2 is unavailable under this Xvfb (no GLX). It only appears with `--use-angle=swiftshader --enable-unsafe-swiftshader`, a CPU emulation that says nothing about GPU cost. It needs a real-GPU host, and a Canvas 2D fallback would remain necessary.

Also observed: `bench:reload:budget` failed intermittently on every tree this session, the untouched baseline included (3 of 5), always with a corrupted `mux-graph:get` `snapshotJson`. It passed repeatedly earlier in the day, so it is load- or timing-dependent. It is pre-existing and not diagnosed.

## Follow-up: payload copies and search repaint (same day)

Compared with `a9eb5a5`, same host and toolchain.

- **Main payload copies.** Electron's `Buffer.poolSize` is 64 KiB, so `Buffer.from(payload)` returned pool views for frames under 32 KiB, and the bridge copied every frame again. The parser now parses a lone socket chunk in place, copies only an incomplete-frame remainder, and makes exact-sized payload copies that the bridge posts without a second copy. Parse plus post of a 64 MiB stream in 64 KiB chunks under Electron's Node (medians of 6, both with native CRC): 1 KiB payloads 834 → 942 MiB/s, 4 KiB 972 → 1,331 MiB/s, 16 KiB 1,018 → 1,415 MiB/s; bridge copies per frame 1 → 0. Samples overlap at the 4 KiB tail (57–69 ms vs 39–70 ms). Regression tests cover parser non-aliasing and exact posting.
- **Search highlights.** Highlights are JS-only pixels, so `search()`/`clearSearch()` repainted only rows Ghostty reported dirty; a match on a clean row away from the cursor stayed unhighlighted (surface check failed at `a9eb5a5` with the background colour). One full repaint now follows each search change.
