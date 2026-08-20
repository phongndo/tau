# libghostty WASM and ghostty-web — Tau integration notes

Research date: 2026-08-20

## Verdict

Tau already has the right **daemon** shape: Zig `taud` links **native** `libghostty-vt` (Ghostty 1.3.1) for VT state, snapshots, and metadata. The open question is the **renderer**: today that is xterm.js WebGL, while the persistence plan still sketches a future “Ghostty renderer (WASM).”

For Tau, the highest-leverage path is **not** to run a second Ghostty VT engine in the renderer by default. Prefer:

1. Keep **one authoritative VT core in `taud`** (native Zig module — already done).
2. Treat **official `ghostty-vt.wasm`** and **ghostty-web** as candidate **renderer** replacements or experiments, gated behind benchmarks against current xterm.js WebGL.
3. Prefer **official libghostty WASM + a Tau-owned canvas/WebGL draw path** (or an eventual upstream GPU lib) over long-term dependence on community xterm-compat shims — but ghostty-web is the fastest drop-in experiment.

Do **not** dual-parse the live byte stream in both daemon and renderer as the steady-state design. That wastes CPU and invites VT drift. Either the renderer is a dumb paint surface for daemon cell/snapshot state, or the renderer owns display VT and the daemon uses VT only for durability/search — not both as full re-parsers of every byte forever.

---

## What Tau has today

| Layer | Technology | Role |
| --- | --- | --- |
| Daemon VT | Zig-native `ghostty-vt` via `apps/daemon/src/vt_ghostty_native.zig` | Parse PTY output, current-screen snapshots, plain-text/search extracts |
| Renderer | `@xterm/xterm` + WebGL addon | Parse bytes again, layout, GPU paint, selection, search, images, links |
| Bridge | Unix socket + MessagePort | Binary output frames; snapshots applied as VT restore ANSI into xterm |
| Pin | Ghostty `v1.3.1` in `apps/daemon/build.zig.zon` | Same major line as community WASM packages |

Docs already state the daemon path is **no WASM** (`docs/plans/persistence.md`). `TODO.md` still has: audit any copied Ghostty WASM artifact and remove it if unused — the production renderer does not ship `ghostty-web`; benches fetch WASM on demand from npm (`apps/desktop/bench/benchmark.ts`).

Measured cross-reference (from `apps/desktop/bench/TAUD-BENCHMARK-RESULTS.md`):

| Workload | ghostty-web WASM | xterm.js JS |
| --- | --- | --- |
| 1MB plain | ~44.5 MB/s | ~35.7 MB/s |
| 1MB ANSI-heavy | ~35.7 MB/s | ~16.5 MB/s |
| 1000 tiny writes | ~276 ms | ~1680 ms |

Native daemon VT is estimated ~1.5–2× faster still than WASM. So WASM wins vs xterm’s JS parser, but loses vs Tau’s existing native path.

---

## Official libghostty WASM

### Status (upstream Ghostty)

- Roadmap item: cross-platform `libghostty`, starting with **`libghostty-vt`**.
- Mitchell Hashimoto’s Sept 2025 post announced `libghostty-vt` and explicitly planned **web via WASM**.
- Ghostty **1.3.1 README** states `libghostty-vt` is usable for Zig and C on macOS, Linux, Windows, and **WebAssembly**; API still unstable / untagged as a standalone product.
- C docs: [libghostty.tip.ghostty.org](https://libghostty.tip.ghostty.org/) — groups include Terminal, **Render State**, Formatter, Snapshot, Key/Mouse encoding, and **WebAssembly Utilities**.

### Build

From Ghostty’s agent/dev docs:

```bash
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
# → zig-out/bin/ghostty-vt.wasm
```

The build exports a growable indirect function table (patched post-link) so JS can register terminal-effect callbacks. Official example: `example/wasm-vt/` — load WASM over HTTP, allocate via `ghostty_wasm_*`, create terminal, `ghostty_terminal_vt_write`, format with `ghostty_formatter_*`, using **type-layout JSON** (`ghostty_type_json`) for struct offsets across ABI churn.

### What official WASM is (and is not)

**Is:** the same VT core as native Ghostty — parse, screen/scrollback state, formatters, key/mouse encoding helpers, WASM alloc conveniences.

**Is not (yet):** a complete browser terminal widget. There is no shipped Metal/OpenGL/WebGL paint stack for the web in `libghostty-vt`. Embedding still needs a host-drawn grid (Canvas/WebGL/DOM) or a higher-level wrapper.

**API risk:** official C/WASM signatures are still in flux. The wasm-vt example already depends on layout JSON rather than hard-coded offsets — correct for consumers, painful for a thin Electron glue layer that must track tip.

---

## “web-ghostty” / ghostty-web ecosystem

There is no single upstream product named “web-ghostty.” The practical landscape:

### 1. `ghostty-web` (Coder) — primary “Ghostty for the web”

- Repo: [coder/ghostty-web](https://github.com/coder/ghostty-web) (npm: `ghostty-web`)
- Pitch: **xterm.js-compatible API** + Ghostty VT compiled to WASM (~400KB), zero runtime deps.
- Built originally for Coder’s Mux; demo: `npx @ghostty-web/demo@next`.
- Builds Ghostty with a **patch** (`patches/ghostty-wasm-api.patch`) exposing a high-performance **RenderState** surface (single update + bulk viewport cells — minimize WASM↔JS crossings).
- Roadmap note: intend to consume an official Ghostty WASM distribution when available; keep xterm-compat API.
- Claims better complex-script / grapheme behavior and sequences xterm still lacks (e.g. XTPUSHSGR/XTPOPSGR).

**Tau relevance:** closest to a **swap `@xterm/xterm` → `ghostty-web`** experiment. Matches Tau’s existing imperative terminal module shape (`apps/desktop/src/renderer/terminal.ts`) if addon surface is close enough.

**Risks for Tau:**

- Community patch surface vs Tau’s pinned official Zig module — two Ghostty ABIs to track.
- Addon parity: Tau uses fit, WebGL, search, unicode11, graphemes, web-links, image, clipboard. ghostty-web markets API compatibility; WebGL/image/search parity must be proven, not assumed.
- Bundle size (~400KB WASM) vs Tau’s “smallest practical distribution above Electron” goal — acceptable if it replaces xterm + several addons, not if it sits beside them.
- Still a **second** full VT parser if daemon keeps parsing every byte.

### 2. `@slopus/ghostty-wasm`

- Prebuilt Ghostty **1.3.1** WASM + TypeScript API (Node + browser loaders).
- **Not** an xterm drop-in. Exposes `write` / resize / scroll / **cell snapshots** (`snapshot`, `snapshotPage`, `snapshotScrollback`) — renderer-neutral.
- Small wasm32 allocator patches; richer JS ABI for cells, styles, OSC 8, PTY query responses (`onPtyWrite`).
- Explicitly leaves Canvas/WebGL/font metrics to the host.

**Tau relevance:** best model if Tau wants **Ghostty VT in the renderer** while owning paint itself (or later streaming cell diffs from daemon). Aligns with “RenderState / snapshot” thinking without buying Coder’s xterm facade.

### 3. Other consumers

- Obsidian “Ghostty Terminal” plugin: embeds ghostty-web WASM + host PTY helper — proof that WASM Ghostty embeds in Electron-like hosts.
- `@wterm/ghostty` / forks: earlier WASM packaging; `@slopus` cites allocator approach from `@wterm/ghostty`.
- Ghostling / awesome-libghostty: native embed examples; less relevant to Electron renderer.

---

## Integration options for Tau

### Option A — Status quo (recommended near-term default)

**Daemon:** native `libghostty-vt`. **Renderer:** xterm.js WebGL.

- Finish byte-path work (transferable buffers, acks, snapshot resync) and parity roadmap P0/P1.
- Keep ghostty-web only as a **bench harness** (already true).
- Close `TODO.md` WASM-artifact audit: confirm no production copy; document bench-only fetch.

**Why:** Tau’s differentiator is mux durability + daemon authority, not reimplementing a browser VT. Native daemon VT already beats WASM on throughput.

### Option B — Drop-in ghostty-web renderer experiment

Replace `@xterm/xterm` imports with `ghostty-web` behind a feature flag / bench build.

**Validate before committing:**

1. Packaged key-to-display and flood SLOs vs WebGL xterm.
2. Addon matrix: search, selection, clipboard, links, images, Unicode width.
3. Snapshot apply path: Ghostty-native current-screen VT bytes into ghostty-web must match native daemon state.
4. Memory with N visible panes + hidden LRU.
5. License/build: pin WASM artifact; prefer consuming official `ghostty-vt.wasm` when Coder drops the patch.

**Fit:** fastest way to answer “does Ghostty-in-renderer beat xterm for Tau?” without inventing a paint stack.

### Option C — Official WASM VT + Tau-owned renderer

Build or vendor `ghostty-vt.wasm` from the same Ghostty revision as `build.zig.zon`. Use `@slopus`-style snapshots or official Render State C API from JS; draw with Canvas2D/WebGL (or keep a thin xterm-like facade only for input/selection UX).

**Pros:** single Ghostty version pin with daemon; no xterm JS parser; path toward shared snapshot formats.

**Cons:** large engineering surface (fonts, ligatures, selection, IME, accessibility, images); official API churn; Tau becomes a terminal graphics project.

### Option D — Eliminate renderer VT parse (architectural endgame)

Have `taud` emit **incremental render/state frames** (or shared-memory cell grids) and treat the Electron surface as paint-only.

**Pros:** one VT truth; aligns with “Ghostty renderer (WASM)” diagram only if WASM is used as an optional local paint helper, not a second parser.

**Cons:** new protocol, backpressure model, and scrollback UX; larger than a library swap. Only justified after Option B/C show paint is the bottleneck and dual-parse is the cost.

### Option E — Daemon stays native; WASM for non-Electron surfaces

If Tau later ships a true web client, headless preview, or extension host that cannot link Zig, use official WASM / ghostty-web there — not inside the desktop hot path.

---

## Dual-parse problem (important)

Current hot path conceptually:

```text
PTY → taud (libghostty-vt) → binary stream → Electron → xterm.write → xterm VT parse → WebGL
```

Both engines interpret the same sequences. Snapshots mitigate attach/resync by feeding VT restore bytes into xterm, but live output still double-parses.

| Design | Daemon VT | Renderer VT |
| --- | --- | --- |
| Today | Full | Full (xterm) |
| B/C with live bytes | Full | Full (Ghostty WASM) — same waste, better correctness match |
| D (cell stream) | Full | None / paint only |
| Renderer-authoritative (not Tau’s model) | Metadata only | Full |

Recommendation: any Ghostty WASM renderer adoption should include a **written decision** on whether daemon VT remains full-fidelity on the hot path or becomes snapshot/search-only.

---

## Suggested experiments (cheap → expensive)

1. **Artifact audit (hours):** confirm production bundle has no `ghostty-vt.wasm`; document bench-only use; resolve `TODO.md` item.
2. **Pinned official WASM smoke (hours–days):** build `ghostty-vt.wasm` from Tau’s Ghostty 1.3.1 pin; run upstream wasm-vt example; note ABI vs ghostty-web patched exports.
3. **ghostty-web feature-flag spike (days):** one pane path; SLO + addon checklist; no default enable.
4. **Snapshot round-trip matrix:** daemon `ghostty_native` snapshot → xterm vs ghostty-web vs official WASM formatter; golden screens for box drawing / wide glyphs / SGR.
5. **Only if spike wins:** design cell/render-state protocol or shared revision pin for Option C/D.

---

## Recommendation summary

| Priority | Action |
| --- | --- |
| Now | Keep native `libghostty-vt` in `taud`; keep xterm WebGL as production renderer. |
| Now | Treat ghostty-web / official WASM as **research + benches**, not core deps. |
| Next | Feature-flag ghostty-web spike with packaged SLOs and addon parity gates. |
| Later | Prefer official `ghostty-vt.wasm` (same pin as daemon) over patched npm forks once Render State / snapshot APIs stabilize. |
| Avoid | Shipping dual full VT parsers permanently; depending on unstable tip WASM without a pin strategy; assuming xterm addon parity. |

Tau’s persistence target diagram’s “Ghostty renderer (WASM)” remains a **plausible Phase-N renderer**, not a substitute for the Zig daemon. Integrate WASM only when it removes xterm’s costs or unlocks a non-Electron surface — not because Ghostty WASM exists.
