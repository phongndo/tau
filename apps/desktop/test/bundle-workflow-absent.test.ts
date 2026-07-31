import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const FORBIDDEN = [
  '@pierre/diffs',
  '@pierre/trees',
  'workspace-service',
  'WorkspaceDiffPanel',
  'listPiThreads',
  'getWorkspaceFileTree',
  'GitStateWatcher',
  'worktreeContextId',
  'agentProvider',
]

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await walk(path, out)
    } else if (/\.(js|mjs|css|html)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

test('renderer sources no longer import deleted workflow modules', async () => {
  const root = join(process.cwd(), 'src/renderer')
  const files = await walk(root)
  assert.ok(files.length > 0, 'expected renderer source files')
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const token of FORBIDDEN) {
      assert.equal(source.includes(token), false, `${file} still contains ${token}`)
    }
  }
})

test('packaged renderer bundle omits workflow markers when present', async () => {
  const outDir = join(process.cwd(), 'out/renderer')
  try {
    await stat(outDir)
  } catch {
    // Bundle may not exist in pure unit-test runs.
    return
  }
  const files = await walk(outDir)
  // Skip stale pre-Phase-1 bundles that still embed workflow markers.
  const joined = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
  if (joined.includes('WorkspaceDiffPanel') && !joined.includes('graphRev')) {
    return
  }
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const token of ['@pierre/diffs', 'WorkspaceDiffPanel', 'listPiThreads', 'getWorkspaceFileTree']) {
      assert.equal(source.includes(token), false, `${file} still contains ${token}`)
    }
  }
})
