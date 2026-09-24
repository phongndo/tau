import { homedir } from 'node:os'
import { Schema } from 'effect'
import { SettingsDataSchema, type SettingsData } from '@tau/shared/session'
import { validateSettings } from '@tau/shared/preferences'
import { resolveTauStoragePaths } from '@tau/shared/storage-path'
import { readJsonFile, writeJsonFile } from './file-store'

const settingsPath = resolveTauStoragePaths(homedir()).settings

export async function readSettings(): Promise<SettingsData | null> {
  const data = await readJsonFile<unknown>(settingsPath)
  if (data === null) return null

  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  return decoded._tag === 'Some' ? decoded.value : null
}

export async function writeSettings(data: SettingsData): Promise<void> {
  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid settings data')
  validateSettings(decoded.value)
  await writeJsonFile(settingsPath, decoded.value)
}
