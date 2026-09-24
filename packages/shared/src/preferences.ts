import type { SettingsData } from './session'

export const shortcuts = [
  { id: 'new-tab', label: 'New tab', defaultKey: 'Mod+T', linuxKey: 'Ctrl+Shift+T' },
  { id: 'close-tab', label: 'Close tab', defaultKey: 'Mod+Shift+W', linuxKey: 'Ctrl+Shift+Q' },
  { id: 'close-pane', label: 'Close pane', defaultKey: 'Mod+W', linuxKey: 'Ctrl+Shift+W' },
  { id: 'close-pane-ctrl', label: 'Close pane (alternate)', defaultKey: '' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', defaultKey: 'Mod+B', linuxKey: 'Ctrl+Shift+B' },
  { id: 'split-right', label: 'Split right', defaultKey: 'Mod+D', linuxKey: 'Ctrl+Shift+D' },
  { id: 'split-down', label: 'Split down', defaultKey: 'Mod+Shift+D', linuxKey: 'Ctrl+Shift+E' },
  { id: 'search', label: 'Find in terminal', defaultKey: 'Mod+F', linuxKey: 'Ctrl+Shift+F' },
  { id: 'settings', label: 'Open settings', defaultKey: 'Mod+,', linuxKey: 'Ctrl+Alt+S' },
  { id: 'next-tab', label: 'Next tab', defaultKey: 'Ctrl+Tab' },
  { id: 'previous-tab', label: 'Previous tab', defaultKey: 'Ctrl+Shift+Tab' },
  {
    id: 'focus-left',
    label: 'Focus left pane',
    defaultKey: 'Mod+Alt+ArrowLeft',
    linuxKey: 'Ctrl+Shift+ArrowLeft',
  },
  {
    id: 'focus-down',
    label: 'Focus lower pane',
    defaultKey: 'Mod+Alt+ArrowDown',
    linuxKey: 'Ctrl+Shift+ArrowDown',
  },
  {
    id: 'focus-up',
    label: 'Focus upper pane',
    defaultKey: 'Mod+Alt+ArrowUp',
    linuxKey: 'Ctrl+Shift+ArrowUp',
  },
  {
    id: 'focus-right',
    label: 'Focus right pane',
    defaultKey: 'Mod+Alt+ArrowRight',
    linuxKey: 'Ctrl+Shift+ArrowRight',
  },
  { id: 'tab-1', label: 'Switch to tab 1', defaultKey: 'Mod+1' },
  { id: 'tab-2', label: 'Switch to tab 2', defaultKey: 'Mod+2' },
  { id: 'tab-3', label: 'Switch to tab 3', defaultKey: 'Mod+3' },
  { id: 'tab-4', label: 'Switch to tab 4', defaultKey: 'Mod+4' },
  { id: 'tab-5', label: 'Switch to tab 5', defaultKey: 'Mod+5' },
  { id: 'tab-6', label: 'Switch to tab 6', defaultKey: 'Mod+6' },
  { id: 'tab-7', label: 'Switch to tab 7', defaultKey: 'Mod+7' },
  { id: 'tab-8', label: 'Switch to tab 8', defaultKey: 'Mod+8' },
  { id: 'tab-9', label: 'Switch to tab 9', defaultKey: 'Mod+9' },
  { id: 'tab-0', label: 'Switch to tab 10', defaultKey: 'Mod+0' },
] as const

export type ShortcutId = (typeof shortcuts)[number]['id']

export function defaultShortcutKey(shortcut: (typeof shortcuts)[number], platform: string): string {
  return platform === 'darwin'
    ? shortcut.defaultKey
    : 'linuxKey' in shortcut
      ? shortcut.linuxKey
      : shortcut.defaultKey.replace('Mod+', 'Alt+')
}

export const defaultSettings: SettingsData = {
  version: 1,
  appearance: { theme: 'system', accent: 'blue', sidebar: true },
  terminal: { fontSize: 14, fontFamily: 'monospace' },
  behavior: { confirmClose: false },
  keybindings: {},
  persistence: {
    enabled: true,
    retainDays: 30,
    maxSessionBytes: 2 * 1024 * 1024 * 1024,
    persistInput: false,
  },
}

const fontFamilies = new Set([
  'monospace',
  'JetBrains Mono, monospace',
  'SF Mono, Menlo, monospace',
  'Cascadia Code, monospace',
])

export function validateSettings(value: SettingsData): void {
  if (value.version !== 1) throw new Error('Unsupported settings version')
  const colors = value.appearance?.customColors
  if (colors && Object.values(colors).some((color) => !/^#[0-9a-fA-F]{6}$/u.test(color)))
    throw new Error('Invalid custom mux color')
  if (
    value.terminal &&
    (!Number.isInteger(value.terminal.fontSize) ||
      value.terminal.fontSize < 10 ||
      value.terminal.fontSize > 28 ||
      !fontFamilies.has(value.terminal.fontFamily))
  )
    throw new Error('Invalid terminal appearance')
  const persistence = value.persistence
  if (
    persistence &&
    (!Number.isInteger(persistence.retainDays) ||
      persistence.retainDays < 1 ||
      persistence.retainDays > 3650 ||
      !Number.isSafeInteger(persistence.maxSessionBytes) ||
      persistence.maxSessionBytes < 1 ||
      persistence.maxSessionBytes > 16 * 1024 * 1024 * 1024)
  )
    throw new Error('Invalid session retention')
  for (const [id, key] of Object.entries(value.keybindings ?? {})) {
    if (
      !shortcuts.some((shortcut) => shortcut.id === id) ||
      key.length > 48 ||
      (key &&
        !/^(?:(?:Ctrl|Meta|Mod|Alt|Shift)\+){1,4}(?:[A-Z0-9]|Tab|Enter|Escape|,|Arrow(?:Up|Down|Left|Right))$/u.test(
          key,
        ))
    )
      throw new Error('Invalid keybinding')
  }
}

/** Upgrade older settings without dropping saved persistence preferences. */
export function resolveSettings(value: SettingsData | null): SettingsData {
  if (!value) return structuredClone(defaultSettings)
  const appearance = value.appearance ?? defaultSettings.appearance!
  return {
    version: 1,
    appearance: {
      ...appearance,
      theme:
        appearance.theme === 'midnight' || appearance.theme === 'slate' ? 'dark' : appearance.theme,
      ...(appearance.theme === 'slate' && !appearance.customColors
        ? { customColors: { chrome: '#293038', sidebar: '#282c31' } }
        : {}),
    },
    terminal: value.terminal ?? defaultSettings.terminal,
    behavior: value.behavior ?? defaultSettings.behavior,
    keybindings: value.keybindings ?? {},
    persistence: value.persistence ?? defaultSettings.persistence,
  }
}
