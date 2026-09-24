import { shortcuts, type ShortcutId } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'

export type KeyInput = {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/** Reject malformed bindings rather than accidentally hijacking terminal keystrokes. */
export function parseBinding(value: string): KeyInput | null {
  const parts = value.split('+').map((part) => part.trim().toLowerCase())
  const key = parts.pop()
  if (!key || !/^(?:[a-z0-9]|tab|enter|escape|,|arrow(?:up|down|left|right))$/u.test(key))
    return null
  const modifiers = new Set(parts.map((part) => (part === 'mod' ? 'meta' : part)))
  if (
    modifiers.size !== parts.length ||
    [...modifiers].some((part) => !['ctrl', 'meta', 'alt', 'shift'].includes(part))
  )
    return null
  if (!modifiers.has('ctrl') && !modifiers.has('meta') && !modifiers.has('alt')) return null
  return {
    key,
    control: modifiers.has('ctrl'),
    meta: modifiers.has('meta'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  }
}

export function conflictingShortcut(settings: SettingsData): string | null {
  const seen = new Set<string>()
  for (const shortcut of shortcuts) {
    const configured = settings.keybindings?.[shortcut.id]
    if (configured === '') continue
    const binding = parseBinding(configured ?? shortcut.defaultKey)
    if (!binding) return shortcut.id
    const identity = JSON.stringify(binding)
    if (seen.has(identity)) return shortcut.id
    seen.add(identity)
  }
  return null
}

export function findShortcut(input: KeyInput, settings: SettingsData): ShortcutId | null {
  for (const shortcut of shortcuts) {
    const configured = settings.keybindings?.[shortcut.id]
    // Empty string intentionally unbinds a command, passing the key to the terminal.
    if (configured === '') continue
    const binding = parseBinding(configured ?? shortcut.defaultKey)
    if (
      binding &&
      binding.key === input.key.toLowerCase() &&
      binding.control === input.control &&
      binding.meta === input.meta &&
      binding.alt === input.alt &&
      binding.shift === input.shift
    )
      return shortcut.id
  }
  return null
}
