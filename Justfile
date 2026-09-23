set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

default:
    @just --list

# Prepare a fresh worktree for local development (postinstall repairs Electron).
setup: _ensure-package-manager
    bun install --frozen-lockfile

[unix]
_ensure-package-manager:
    if ! command -v bun >/dev/null 2>&1; then \
        echo "Bun was not found. Enter nix develop or install the version in package.json." >&2; \
        exit 1; \
    fi

[windows]
_ensure-package-manager:
    $ErrorActionPreference = 'Stop'; if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Write-Error 'Install the Bun version in package.json first.'; exit 1 }

# Re-run Electron's install/repair step after dependencies are present.
electron:
    bun scripts/electron-install.ts

# Kill any running taud daemon and start a fresh dev server.
[unix]
dev:
    pkill -TERM -x taud || true
    for _ in {1..20}; do pgrep -x taud >/dev/null || break; sleep 0.1; done
    if pgrep -x taud >/dev/null; then echo "taud did not stop after TERM" >&2; exit 1; fi
    bun run dev

[windows]
dev:
    $ErrorActionPreference = 'Stop'; Get-Process -Name taud -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 20 -and (Get-Process -Name taud -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }; if (Get-Process -Name taud -ErrorAction SilentlyContinue) { throw 'taud did not stop after stop request' }; bun run dev
