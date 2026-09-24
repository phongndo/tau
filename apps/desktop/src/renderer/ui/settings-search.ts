import { defaultShortcutKey, shortcuts } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'

export const settingsSections = [
  'Appearance',
  'Terminal',
  'Multiplexer',
  'Keyboard',
  'Sessions',
  'Daemon',
] as const

export type SettingsSection = (typeof settingsSections)[number]

export type SettingItem = {
  id: string
  section: SettingsSection
  title: string
  description?: string
  terms?: string
}

export const settingItems = {
  colorPalette: {
    id: 'color-palette',
    section: 'Appearance',
    title: 'Appearance',
    terms: 'system dark light theme colors interface',
  },
  customColors: {
    id: 'custom-colors',
    section: 'Appearance',
    title: 'Mux colors',
    description:
      'Customize tabs, sidebar, text, and accent without changing terminal program colors.',
    terms: 'custom theme chrome tab sidebar foreground background',
  },
  accent: {
    id: 'accent',
    section: 'Appearance',
    title: 'Accent',
    terms: 'selection focus highlight tint blue violet mint color',
  },
  sidebar: {
    id: 'sidebar',
    section: 'Appearance',
    title: 'Show sidebar',
    terms: 'hide tabs rail navigation',
  },
  fontSize: {
    id: 'font-size',
    section: 'Terminal',
    title: 'Font size',
    description: 'Applies to every live terminal and refits the PTY grid.',
    terms: 'text zoom scale',
  },
  fontFamily: {
    id: 'font-family',
    section: 'Terminal',
    title: 'Font family',
    terms: 'typeface monospace jetbrains menlo cascadia',
  },
  confirmClose: {
    id: 'confirm-close',
    section: 'Multiplexer',
    title: 'Confirm before closing',
    description: 'Ask before closing a tab or pane. Closing a view keeps its session alive.',
    terms: 'warning close tab pane',
  },
  saveHistory: {
    id: 'save-history',
    section: 'Sessions',
    title: 'Save session history',
    description: 'Retain output and snapshots so detached sessions can be recovered.',
    terms: 'persistence resume record output',
  },
  retention: {
    id: 'retention',
    section: 'Sessions',
    title: 'Retention',
    description: 'Delete expired session history after this many days.',
    terms: 'cleanup days delete history',
  },
  storageLimit: {
    id: 'storage-limit',
    section: 'Sessions',
    title: 'Storage limit',
    description: 'Maximum on-disk bytes retained per session.',
    terms: 'disk quota space size',
  },
  recordInput: {
    id: 'record-input',
    section: 'Sessions',
    title: 'Record input',
    description: 'Store keystrokes as well as output. May include secrets; off by default.',
    terms: 'keyboard privacy history',
  },
  daemonStatus: {
    id: 'daemon-status',
    section: 'Daemon',
    title: 'Status',
    description: 'PTYs and session history are owned by the terminal service.',
    terms: 'service connected connection health',
  },
  daemonRecovery: {
    id: 'daemon-recovery',
    section: 'Daemon',
    title: 'Recovery',
    terms: 'service reconnect restart repair error',
  },
  resetShortcuts: {
    id: 'reset-shortcuts',
    section: 'Keyboard',
    title: 'Restore default shortcuts',
    terms: 'reset keybindings hotkeys',
  },
} as const satisfies Record<string, SettingItem>

export type SettingsSearchResult = {
  id: string
  section: SettingsSection
  title: string
  targetId?: string
}

const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()

export function searchSettings(
  query: string,
  keybindings: SettingsData['keybindings'],
  platform = 'darwin',
): SettingsSearchResult[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []
  const tokens = normalizedQuery.split(/\s+/u)
  const entries = [
    ...settingsSections.map((section) => ({
      id: `section:${section}`,
      section,
      title: section,
      targetId: undefined as string | undefined,
      terms: section === 'Multiplexer' ? 'tabs panes splits' : '',
    })),
    ...Object.values(settingItems).map((item) => ({
      ...item,
      targetId: item.id,
      terms: 'terms' in item ? item.terms : '',
    })),
    ...shortcuts
      .filter((shortcut) => shortcut.id !== 'close-pane-ctrl' || !!keybindings?.[shortcut.id])
      .map((shortcut) => ({
        id: `shortcut:${shortcut.id}`,
        section: 'Keyboard' as const,
        title: shortcut.label,
        targetId: `shortcut:${shortcut.id}`,
        terms: `${shortcut.id} ${keybindings?.[shortcut.id] ?? defaultShortcutKey(shortcut, platform)} keybinding shortcut`,
      })),
  ]
  return entries
    .map((entry, index) => {
      const title = normalize(entry.title)
      const haystack = normalize(
        [
          entry.title,
          entry.section,
          'description' in entry ? entry.description : '',
          entry.terms,
        ].join(' '),
      )
      if (!tokens.every((token) => haystack.includes(token))) return null
      const score =
        title === normalizedQuery
          ? 0
          : title.startsWith(normalizedQuery)
            ? 1
            : title.includes(normalizedQuery)
              ? 2
              : tokens.every((token) => title.includes(token))
                ? 3
                : 4
      return { entry, index, score }
    })
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ entry }) => ({
      id: entry.id,
      section: entry.section,
      title: entry.title,
      targetId: entry.targetId,
    }))
}
