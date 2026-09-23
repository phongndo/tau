# Bun tooling and migration benchmark

Measured **2026-09-23** on an Apple M4 Max (16 logical CPUs), macOS arm64 / Darwin 25.6.0,
inside the repository's Nix development shell.

## Tooling boundary

Bun replaces pnpm workspace installation/task execution, Node/tsx TypeScript script
execution, and the Node test runner. Vite/electron-vite and TypeScript's compiler run
under Bun. Electron benchmark entrypoints are compiled by `Bun.build` and launched
with `Bun.spawn`; `tsx` is no longer a dependency.

The application still runs inside **Electron**, with a **Zig** daemon. Its main/preload
APIs and sandboxed renderer cannot run in Bun. Vite remains responsible for React HMR,
Electron's multiple bundle targets, externalization, and resource copying. Replacing
those integrations with a custom Bun build pipeline would be a separate architectural
change, not a clean tooling substitution. Portable Node APIs in app/shared modules
remain portable; they are not rewritten to Bun-only APIs.

Root `package.json` owns the Bun version. Nix reads it and pins upstream binary hashes;
CI's setup-bun action reads the same field. When upgrading Bun, also update the source
hashes in `flake.nix` and the Bun types dependency. Bun 1.4.2 was the
[latest stable release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) when measured.
Node 22 remains available for third-party Node shebangs, not as Tau's script runtime.

`bun.lock` was [migrated from the pnpm lockfile](https://bun.com/docs/pm/lockfile),
not resolved from scratch. Existing application dependency versions were preserved.
Bun's types were added; tsx and now-unused optional/transitive tooling were removed.
The explicit hoisted linker in `bunfig.toml` preserves the former hoisted workspace layout.
Only esbuild's dependency lifecycle script is trusted. The root Bun `postinstall`
owns Electron installation/repair, including NixOS ELF patching; Electron's upstream
install hook is not also run. See [`scripts/electron-install.ts`](../scripts/electron-install.ts) for the implementation.

Use `bun run build` and `bun run test` for the repository workflows. `bun build` invokes
Bun's bundler directly; bare `bun test` discovers additional integration tests rather
than just the curated check suite. Existing tests retain `node:test` compatibility
imports and assertions; Bun's built-in runner executes them without a loader.

## Captured comparison

Baseline: pnpm **11.5.1**, Node **22.22.3**, tsx **4.22.4**.
Migrated: Bun **1.4.2**. Both: Zig **0.15.2**, Electron **42.3.0**, Vite **7.3.5**,
TypeScript **6.0.3**. Lower wall time is better.

| Workflow                                     | pnpm / Node median |  Bun median | Speedup | Less time |
| -------------------------------------------- | -----------------: | ----------: | ------: | --------: |
| Clean install, warm private package cache    |         1,111.0 ms |     98.6 ms |  11.27× |     91.1% |
| No-op frozen install                         |           439.0 ms |     12.9 ms |  34.03× |     97.1% |
| Persistence tests (same 42 tests / 7 files)  |           991.9 ms |    307.4 ms |   3.23× |     69.0% |
| TypeScript checks                            |         2,944.0 ms |  1,555.9 ms |   1.89× |     47.1% |
| Full production build, including native taud |        17,436.9 ms | 15,902.0 ms |   1.10× |      8.8% |
| Artifact inventory script                    |           580.4 ms |     11.7 ms |  49.70× |     98.0% |

Raw samples, ranges, commands, versions, host details, and timestamps:

- [pnpm baseline](benchmarks/tooling-pnpm-2026-09-23.json)
- [Bun result](benchmarks/tooling-bun-2026-09-23.json)

These are **developer-tooling improvements**, not claims that terminal rendering,
PTY throughput, or the shipped app became faster. The full build remains dominated
by native daemon work. Its modest improvement is less robust than the large install
and script-startup differences: build sample ranges overlap.

## Method

[`scripts/bench-tooling.ts`](../scripts/bench-tooling.ts) runs each workload sequentially,
with one discarded warmup and five measured successful runs. It reports the median,
minimum, maximum, and every raw sample. The harness ran under the **same Node 22 runtime**
for both captures, with process startup included and Nix shell startup excluded.
The pnpm capture preceded migration; the Bun capture followed it on the same host.
Runs were not interleaved, so background load and temporal drift remain limitations.

- Install workloads copy only workspace manifests, lockfiles, and package-manager
  configuration to a temporary directory. Each manager has a fresh private cache,
  seeded outside measurement. Clean installs delete only that fixture's node_modules;
  no-op installs leave it installed. Neither touches the caller's installed dependencies
  or global caches.
- Both install workloads use `--frozen-lockfile --ignore-scripts`. They measure dependency
  materialization/validation, **not network downloads, Electron extraction, or postinstall**.
  There is no cold-network install claim. Bun's real frozen install and Electron
  postinstall were exercised separately.
- Tests, typechecks, builds, and artifact inventory use the supplied working tree and
  its real scripts. Builds include the native daemon with warm compiler caches;
  `TAUD_SKIP_NATIVE` was not set. The harness aborts on command failure.
- Baseline revision: `5a7b1b01205c0607a023d5543699b60f8b4888ad`. Both captures report
  `dirty: true`: baseline had the newly added benchmark harness; Bun had the migration
  changes on that revision. This is a before/after workflow comparison, not an isolated
  JavaScript-engine microbenchmark. The migrated typecheck also covers new tooling tests.

## Reproduce

Current Bun workflow:

```bash
nix develop -c bun install --frozen-lockfile
nix develop -c bun run bench:tooling --manager bun --output out/bench/tooling-bun.json
```

To compare revisions, keep the harness outside the baseline checkout. Each checkout
must have its own matching package-manager configuration and installed dependencies;
do not run pnpm over the migrated Bun scripts and call that a pnpm baseline. The harness
rejects mismatched `packageManager` declarations.

For example, from the migrated repository (POSIX shell):

```bash
repo="$PWD"
baseline="$(mktemp -d)/tau-pnpm"
git worktree add --detach "$baseline" 5a7b1b01205c0607a023d5543699b60f8b4888ad
(
  cd "$baseline"
  nix develop -c pnpm install --frozen-lockfile
  nix develop -c node --experimental-strip-types "$repo/scripts/bench-tooling.ts" \
    --manager pnpm --cwd "$baseline" --output "$repo/out/bench/tooling-pnpm.json"
)
nix develop -c node --experimental-strip-types scripts/bench-tooling.ts \
  --manager bun --output out/bench/tooling-bun.json
# After inspecting the results, remove the temporary worktree when no longer needed.
git worktree remove "$baseline"
```

Optional `--runs N --warmups N` flags increase sampling. Use the same harness runtime,
host, sample counts, native-build settings, and cache conditions for both revisions.
The baseline's pinned pnpm is a measurement dependency only; normal development and CI
no longer require it.
