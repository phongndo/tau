import { createInterface } from 'node:readline'
import { defaultSettings, resolveSettings } from '@tau/shared/preferences'
import { readSettings, writeSettings } from '../main/settings-store'

// Private stdio protocol: only Electron main spawns this process. Never expose a socket or HTTP port.
for await (const line of createInterface({ input: process.stdin })) {
  let id: number | null = null
  try {
    if (line.length > 128 * 1024) throw new Error('Request too large')
    const request = JSON.parse(line) as { id?: unknown; method?: unknown; data?: unknown }
    if (!Number.isSafeInteger(request.id) || (request.id as number) < 0)
      throw new Error('Invalid request id')
    id = request.id as number
    if (request.method === 'read') {
      process.stdout.write(
        `${JSON.stringify({ id, result: resolveSettings((await readSettings()) ?? defaultSettings) })}\n`,
      )
    } else if (request.method === 'write') {
      await writeSettings(request.data as never)
      process.stdout.write(`${JSON.stringify({ id, result: true })}\n`)
    } else {
      throw new Error('Unknown method')
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
    )
  }
}
