import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TaudStreamFrameKind } from '@tau/shared/taud-protocol'
import { resolveTauStoragePaths } from '@tau/shared/storage-path'
import { TaudClient } from '../src/main/taud-client'
import { readProcessCwd } from '../src/main/process-title'
import { decodeTaudExitPayload } from '../src/main/taud-stream'

const binary = resolve(import.meta.dir, '../../daemon/zig-out/bin/taud')
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test(
  'nested shell exit returns to parent; reset keeps the PTY usable; final exit ends it',
  {
    skip: process.platform === 'win32' || !existsSync(binary),
  },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'tau-shell-exit-'))
    const inner = join(home, 'inner')
    mkdirSync(inner)
    const previousHome = process.env.HOME
    const previousBinary = process.env.TAUD_PATH
    process.env.HOME = home
    process.env.TAUD_PATH = binary
    const client = new TaudClient({
      socketPath: resolveTauStoragePaths(home).socket,
      detachDaemon: false,
      healthCheckIntervalMs: 0,
    })
    let stream: Awaited<ReturnType<TaudClient['attachSession']>>['stream'] | undefined
    try {
      await client.ensureRunning()
      await client.createSession({
        sessionId: 'shell-exit',
        terminalId: 'terminal-exit',
        cols: 80,
        rows: 24,
        cwd: home,
        argv: [process.env.SHELL || '/bin/sh'],
      })
      const attached = await client.attachSession({ sessionId: 'shell-exit' })
      const pid = attached.response.pid
      assert.ok(pid)
      stream = attached.stream
      let output = ''
      let exitCode: number | undefined
      stream.on('frame', (frame) => {
        if (frame.kind === TaudStreamFrameKind.Output)
          output += Buffer.from(frame.payload).toString('utf8')
        if (frame.kind === TaudStreamFrameKind.Exit)
          exitCode = decodeTaudExitPayload(frame.payload)?.exitCode
      })
      stream.start()
      stream.writeInput('sh\n')
      await sleep(200)
      stream.writeInput(`cd ${inner}\n`)
      await until(
        async () => (await readProcessCwd(pid)) === realpathSync(inner),
        'nested shell cwd',
      )
      stream.writeInput('exit\n')
      await sleep(200)
      assert.equal(exitCode, undefined, 'exiting a subshell must not exit the PTY')
      await until(
        async () => (await readProcessCwd(pid)) === realpathSync(home),
        'parent shell cwd',
      )
      stream.writeInput('echo PARENT_STILL_ALIVE\n')
      await until(() => output.includes('PARENT_STILL_ALIVE'), 'parent shell output')
      stream.writeInput('reset\n')
      await sleep(200)
      stream.writeInput('echo AFTER_RESET\n')
      await until(() => output.includes('AFTER_RESET'), 'output after reset')
      stream.writeInput('exit\n')
      await until(() => exitCode !== undefined, 'final PTY exit')
      assert.equal(exitCode, 0)
    } finally {
      stream?.close()
      await client.dispose()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousBinary === undefined) delete process.env.TAUD_PATH
      else process.env.TAUD_PATH = previousBinary
      rmSync(home, { recursive: true, force: true })
    }
  },
)
