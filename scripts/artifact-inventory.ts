#!/usr/bin/env tsx
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

type Entry = { path: string; bytes: number; sha256?: string }

function walk(dir: string, out: Entry[] = [], root = dir): Entry[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out, root)
    else out.push({ path: relative(root, full), bytes: st.size })
  }
  return out
}

function categorize(path: string): string {
  if (path.includes('taud') || path.endsWith('/taud')) return 'taud'
  if (path.includes('node_modules/electron') || path.includes('Electron')) return 'electron'
  if (path.includes('.wasm')) return 'wasm'
  if (path.includes('font') || path.endsWith('.ttf') || path.endsWith('.otf')) return 'fonts'
  if (path.includes('extension')) return 'extensions'
  if (path.endsWith('.node')) return 'native-modules'
  if (path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html') || path.endsWith('.mjs'))
    return 'tau-js-css'
  return 'other'
}

const roots = [
  join(process.cwd(), 'apps/desktop/out'),
  join(process.cwd(), 'apps/daemon/zig-out'),
].filter(existsSync)

const entries: Array<Entry & { category: string }> = []
for (const root of roots) {
  for (const entry of walk(root)) {
    entries.push({ ...entry, path: join(relative(process.cwd(), root), entry.path), category: categorize(entry.path) })
  }
}

const byCategory: Record<string, number> = {}
for (const entry of entries) {
  byCategory[entry.category] = (byCategory[entry.category] ?? 0) + entry.bytes
}

const report = {
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  totalsByCategoryBytes: byCategory,
  totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  entries: entries.sort((a, b) => b.bytes - a.bytes).slice(0, 200),
}

const outDir = join(process.cwd(), 'out/ci')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'artifact-inventory.json')
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ outPath, totalsByCategoryBytes: byCategory, totalBytes: report.totalBytes }, null, 2))
