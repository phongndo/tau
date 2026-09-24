# VT ingestion across terminal generations (2026-09-24)

Measured on Linux x86-64 / NixOS, in the repository's Nix dev shell. Revision `2f7a7e0`; the working tree also contained an unrelated README edit. Node 24.15.0 (V8, closer to Electron's JS engine) and Bun 1.4.2 (JavaScriptCore) were measured separately. xterm.js is the installed `@xterm/xterm` 6.0.0, ghostty-web is the **raw WASM ABI** from npm [`ghostty-web@0.4.0-next.14.g6a1a50d`](https://www.npmjs.com/package/ghostty-web/v/0.4.0-next.14.g6a1a50d), and Tau is the current [`GhosttyVt` adapter](../../apps/desktop/src/renderer/ghostty-vt.ts) plus `apps/desktop/public/ghostty-vt.wasm` (pinned upstream in [`scripts/ghostty-source.ts`](../../scripts/ghostty-source.ts)). The latter two use different Ghostty revisions and APIs; the result cannot isolate the effect of Tau's surface from a core upgrade.

### Headless ingestion: Node 24 (median of 5 measured runs)

| Input (same bytes, 120x40)           |           xterm.js | ghostty-web raw WASM |      Tau GhosttyVt |                      ghostty-web → Tau |
| ------------------------------------ | -----------------: | -------------------: | -----------------: | -------------------------------------: |
| 1 MiB plain, 17 writes               | 29.5 ms (34 MiB/s) |   9.6 ms (104 MiB/s) | 1.1 ms (948 MiB/s) |                                  ~8.7× |
| 1 MiB ANSI, 17 writes                | 29.3 ms (34 MiB/s) |   10.8 ms (92 MiB/s) | 1.7 ms (572 MiB/s) |                                  ~6.4× |
| 128 KB ANSI, 1,000 sequential writes |           1,080 ms |               2.7 ms |             1.5 ms | **Not comparable as parse throughput** |

Node raw sample times, in ms, by row (xterm / ghostty-web / Tau):

- Plain: `[31.2, 30.2, 29.1, 29.5, 27.1]` / `[9.6, 9.2, 10.5, 9.5, 10.4]` / `[1.0, 1.1, 3.3, 1.0, 1.1]`.
- ANSI: `[30.7, 30.3, 27.5, 28.2, 29.3]` / `[10.8, 11.0, 10.5, 10.9, 10.7]` / `[1.9, 1.7, 5.4, 1.7, 1.7]`.
- Tiny: `[1063.8, 1085.0, 1073.5, 1090.5, 1080.4]` / `[2.3, 5.6, 5.9, 2.7, 2.7]` / `[1.3, 2.9, 3.3, 1.5, 1.5]`.

Bun medians for the same plain/ANSI workloads: xterm **25.2/24.1 ms**, ghostty-web **10.4/13.0 ms**, Tau **3.1/4.5 ms**. Engine choice has a substantial effect on the ratios. In the tiny-write case, xterm awaits a callback after **each** write, incurring ~1 ms scheduling per write; the WASM calls complete synchronously. It is a callback-drain latency test, **not** evidence of a ~400× parser advantage. Production Tau also coalesces output frames, so this synthetic pattern does not represent app throughput.

### Method, scope and limitations

[`apps/desktop/bench/vt-generation-comparison.ts`](../../apps/desktop/bench/vt-generation-comparison.ts) generates deterministic ASCII/SGR data, feeds identical byte chunks to each engine, rotates engine order, does one discarded warmup and five measured fresh-terminal runs, and checks that each engine consumed enough data to produce scrollback/visible text. Clock starts after engine instantiation; creation, WASM loading, rendering, Electron IPC, taud, GPU presentation, memory use and idle CPU are **excluded**. Legacy WASM uses its default scrollback setting; xterm/Tau use 10k. Legacy measures the raw WASM API, **not** the ghostty-web JS terminal wrapper or its canvas. Tau measures `GhosttyVt.write`, **not** `TauTerminal.write` + canvas `draw`. xterm's callback includes its async writer scheduling. This is a bounded VT-ingestion comparison, **not a three-way surface or end-to-end app benchmark**, nor a proof that the new app is more efficient overall.

The legacy WASM artifact is 423,910 bytes; the Tau WASM artifact is 5,987,085 bytes on disk (not a compressed distribution size or a memory comparison). The existing xterm DOM/WebGL Electron renderer benchmark was attempted under Xvfb on this host but timed out after 60 seconds; Xvfb's software rendering would not establish hardware presentation performance anyway. Run a separate, common browser-rendered three-way test on a real display/GPU before claiming a surface FPS, frame-pacing or end-to-end speedup.

### Reproduce

The legacy npm tarball can be cached by running the existing `apps/desktop/bench/benchmark.ts` once (it downloads the pinned version into `apps/desktop/.bench-cache` if missing). Ensure `apps/desktop/public/ghostty-vt.wasm` was built for the checked-out revision. Then:

```bash
nix develop -c bun apps/desktop/bench/vt-generation-comparison.ts
nix develop -c bun build apps/desktop/bench/vt-generation-comparison.ts --target=node --packages=external --outfile apps/desktop/.bench-cache/vt-generation-comparison.mjs
nix develop -c env TAU_BENCH_DESKTOP="$PWD/apps/desktop" node apps/desktop/.bench-cache/vt-generation-comparison.mjs
```

The harness's default legacy path is the pinned cached artifact; `TAU_GHOSTTY_WEB_WASM` can override it. Build with Bun, then run with Node for the V8 numbers. See [terminal byte path](../terminal-byte-path.md) for what these timings omit from Tau's real output path.
