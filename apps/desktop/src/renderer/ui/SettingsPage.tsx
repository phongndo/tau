/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Search results are interactive ARIA options, not native select options. */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { defaultSettings, shortcuts } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'
import type {
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryAction,
} from '@tau/shared/taud-protocol'
import {
  searchSettings,
  settingItems,
  settingsSections,
  type SettingItem,
  type SettingsSearchResult,
  type SettingsSection,
} from './settings-search'

export function SettingsPage(props: {
  settings: SettingsData
  onChange(settings: SettingsData): Promise<void>
  onBack(): void
  diagnostics: TaudLifecycleDiagnostics | null
  recovering: boolean
  recoverError: string
  onRecover(action: TaudLifecycleRecoveryAction): Promise<void>
  searchFocusToken: number
}) {
  const [section, setSection] = createSignal<SettingsSection>('Appearance')
  const [error, setError] = createSignal('')
  const [capturing, setCapturing] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal('')
  const [activeResult, setActiveResult] = createSignal(0)
  const [highlighted, setHighlighted] = createSignal<string | null>(null)
  const results = createMemo(() => searchSettings(query(), props.settings.keybindings))
  const searching = () => query().trim().length > 0
  let searchInput: HTMLInputElement | undefined
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  const clearSearch = () => {
    setQuery('')
    setActiveResult(0)
  }
  const openResult = (result: SettingsSearchResult) => {
    clearSearch()
    setSection(result.section)
    if (!result.targetId) return
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(result.targetId!)}"]`,
      )
      if (!row) return
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const control = row.querySelector<HTMLElement>('input, select, button')
      ;(control ?? row).focus({ preventScroll: true })
      setHighlighted(result.targetId!)
      if (highlightTimer) clearTimeout(highlightTimer)
      highlightTimer = setTimeout(() => setHighlighted(null), 1800)
    })
  }
  const searchKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (searching()) clearSearch()
      else searchInput?.blur()
      return
    }
    if (results().length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveResult(
        (index) =>
          (index + (event.key === 'ArrowDown' ? 1 : -1) + results().length) % results().length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results()[activeResult()]
      if (result) openResult(result)
    }
  }
  createEffect(() => {
    if (props.searchFocusToken > 0) searchInput?.focus()
  })
  onMount(() => {
    const focusOnSlash = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || capturing()) return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return
      event.preventDefault()
      searchInput?.focus()
    }
    window.addEventListener('keydown', focusOnSlash)
    onCleanup(() => window.removeEventListener('keydown', focusOnSlash))
  })
  onCleanup(() => {
    if (highlightTimer) clearTimeout(highlightTimer)
  })
  const capture = (id: string | null) => {
    setCapturing(id)
    window.electronAPI.captureShortcut(id !== null)
  }
  onCleanup(() => window.electronAPI.captureShortcut(false))
  const update = (patch: Partial<SettingsData>) => {
    setError('')
    void props
      .onChange({ ...props.settings, ...patch })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  const appearance = () => props.settings.appearance ?? defaultSettings.appearance!
  const terminal = () => props.settings.terminal ?? defaultSettings.terminal!
  const behavior = () => props.settings.behavior ?? defaultSettings.behavior!
  const persistence = () => props.settings.persistence ?? defaultSettings.persistence!
  const setAppearance = (patch: Partial<NonNullable<SettingsData['appearance']>>) =>
    update({ appearance: { ...appearance(), ...patch } })
  const setTerminal = (patch: Partial<NonNullable<SettingsData['terminal']>>) =>
    update({ terminal: { ...terminal(), ...patch } })
  const setPersistence = (patch: Partial<NonNullable<SettingsData['persistence']>>) =>
    update({ persistence: { ...persistence(), ...patch } })
  const setBinding = (id: string, binding: string) => {
    if (
      binding &&
      shortcuts.some(
        (entry) =>
          entry.id !== id &&
          (props.settings.keybindings?.[entry.id] ?? entry.defaultKey).toLowerCase() ===
            binding.toLowerCase(),
      )
    ) {
      setError('This shortcut is already assigned. Clear the other binding first.')
      return
    }
    update({ keybindings: { ...props.settings.keybindings, [id]: binding } })
    capture(null)
  }
  const captureKey = (id: string, event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      capture(null)
      return
    }
    const modifiers = [
      event.ctrlKey && 'Ctrl',
      event.metaKey && 'Meta',
      event.altKey && 'Alt',
      event.shiftKey && 'Shift',
    ].filter(Boolean)
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(key)) return
    if (!/^(?:[A-Z0-9]|Tab|Enter|Escape|,|Arrow(?:Up|Down|Left|Right))$/u.test(key)) return
    setBinding(id, [...modifiers, key].join('+'))
  }
  const Row = (row: { item: SettingItem; description?: string; children: any }) => (
    <div
      class="setting-row"
      classList={{ 'setting-row-highlighted': highlighted() === row.item.id }}
      data-setting-id={row.item.id}
      tabIndex={-1}
    >
      <div class="setting-copy">
        <strong>{row.item.title}</strong>
        <Show when={row.description ?? row.item.description}>
          <p>{row.description ?? row.item.description}</p>
        </Show>
      </div>
      <div class="setting-control">{row.children}</div>
    </div>
  )

  return (
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings navigation">
        <div class="settings-nav-top">
          <button class="settings-back" type="button" onClick={props.onBack}>
            ← <span>Terminal</span>
          </button>
          <select
            class="settings-section-select"
            aria-label="Settings section"
            value={section()}
            onChange={(event) => {
              capture(null)
              clearSearch()
              setSection(event.currentTarget.value as SettingsSection)
            }}
          >
            <For each={settingsSections}>{(item) => <option value={item}>{item}</option>}</For>
          </select>
        </div>
        <div class="settings-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            ref={(element) => {
              searchInput = element
            }}
            type="search"
            value={query()}
            placeholder="Search settings"
            aria-label="Search settings"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searching() && results().length > 0}
            aria-controls={
              searching() && results().length > 0 ? 'settings-search-results' : undefined
            }
            aria-activedescendant={
              searching() && results()[activeResult()]
                ? `settings-result-${results()[activeResult()]!.id}`
                : undefined
            }
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActiveResult(0)
            }}
            onKeyDown={searchKeyDown}
          />
          <Show
            when={searching()}
            fallback={
              <kbd class="settings-search-hint" aria-hidden="true">
                /
              </kbd>
            }
          >
            <button
              type="button"
              class="settings-search-clear"
              aria-label="Clear settings search"
              onClick={() => {
                clearSearch()
                searchInput?.focus()
              }}
            >
              ×
            </button>
          </Show>
        </div>
        <Show
          when={searching()}
          fallback={
            <div class="settings-nav-items">
              <For each={settingsSections}>
                {(item) => (
                  <button
                    type="button"
                    class="settings-nav-item"
                    classList={{ current: section() === item }}
                    onClick={() => {
                      capture(null)
                      setSection(item)
                    }}
                    aria-current={section() === item ? 'page' : undefined}
                  >
                    {item}
                  </button>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={results().length > 0}
            fallback={<output class="settings-search-empty">No settings found</output>}
          >
            <div
              class="settings-search-results"
              id="settings-search-results"
              role="listbox"
              aria-label="Settings search results"
            >
              <For each={results()}>
                {(result, index) => (
                  <button
                    type="button"
                    id={`settings-result-${result.id}`}
                    class="settings-search-result"
                    classList={{ current: activeResult() === index() }}
                    role="option"
                    aria-selected={activeResult() === index()}
                    onMouseEnter={() => setActiveResult(index())}
                    onClick={() => openResult(result)}
                  >
                    <span class="settings-search-result-title">{result.title}</span>
                    <span class="settings-search-result-section">{result.section}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </nav>
      <main class="settings-main" aria-label="Settings">
        <div class="settings-content">
          <h1>{section()}</h1>
          <Show when={error()}>
            <div class="settings-error" role="alert">
              {error()}
            </div>
          </Show>
          <Show when={section() === 'Appearance'}>
            <section class="settings-group">
              <Row item={settingItems.colorPalette}>
                <select
                  aria-label="Color palette"
                  value={appearance().theme}
                  onChange={(e) =>
                    setAppearance({ theme: e.currentTarget.value as 'midnight' | 'slate' })
                  }
                >
                  <option value="midnight">Charcoal</option>
                  <option value="slate">Slate</option>
                </select>
              </Row>
              <Row item={settingItems.accent}>
                <div class="swatches">
                  <For each={['blue', 'violet', 'mint'] as const}>
                    {(color) => (
                      <button
                        type="button"
                        class={`swatch swatch-${color}`}
                        classList={{ chosen: appearance().accent === color }}
                        aria-label={`${color} accent`}
                        aria-pressed={appearance().accent === color}
                        onClick={() => setAppearance({ accent: color })}
                      />
                    )}
                  </For>
                </div>
              </Row>
              <Row item={settingItems.sidebar}>
                <input
                  type="checkbox"
                  aria-label="Workspace sidebar"
                  checked={appearance().sidebar}
                  onChange={(e) => setAppearance({ sidebar: e.currentTarget.checked })}
                />
              </Row>
            </section>
          </Show>
          <Show when={section() === 'Terminal'}>
            <section class="settings-group">
              <Row item={settingItems.fontSize}>
                <input
                  type="number"
                  aria-label="Terminal font size"
                  min="10"
                  max="28"
                  step="1"
                  value={terminal().fontSize}
                  onChange={(e) => {
                    const size = Number(e.currentTarget.value)
                    if (size >= 10 && size <= 28) setTerminal({ fontSize: size })
                  }}
                />
                <span class="unit">px</span>
              </Row>
              <Row item={settingItems.fontFamily}>
                <select
                  aria-label="Terminal font family"
                  value={terminal().fontFamily}
                  onChange={(e) => setTerminal({ fontFamily: e.currentTarget.value })}
                >
                  <option value="monospace">System monospace</option>
                  <option value="JetBrains Mono, monospace">JetBrains Mono</option>
                  <option value="SF Mono, Menlo, monospace">SF Mono / Menlo</option>
                  <option value="Cascadia Code, monospace">Cascadia Code</option>
                </select>
              </Row>
            </section>
          </Show>
          <Show when={section() === 'Multiplexer'}>
            <section class="settings-group">
              <Row item={settingItems.confirmClose}>
                <input
                  type="checkbox"
                  aria-label="Confirm before closing"
                  checked={behavior().confirmClose}
                  onChange={(e) =>
                    update({ behavior: { ...behavior(), confirmClose: e.currentTarget.checked } })
                  }
                />
              </Row>
            </section>
          </Show>
          <Show when={section() === 'Keyboard'}>
            <section class="settings-group">
              <p class="card-intro">
                Click a shortcut and press a new combination. Escape cancels; clear passes the key
                to your shell. Mod means ⌘ on macOS or Super on Linux.
              </p>
              <For each={shortcuts}>
                {(item) => (
                  <div
                    class="setting-row shortcut-row"
                    data-setting-id={`shortcut:${item.id}`}
                    classList={{
                      'setting-row-highlighted': highlighted() === `shortcut:${item.id}`,
                    }}
                    tabIndex={-1}
                  >
                    <div class="setting-copy">
                      <strong>{item.label}</strong>
                    </div>
                    <div class="setting-control">
                      <button
                        type="button"
                        class="shortcut-key"
                        aria-label={`${item.label} shortcut`}
                        onClick={() => capture(item.id)}
                        onKeyDown={(event) => {
                          if (capturing() === item.id) captureKey(item.id, event)
                        }}
                      >
                        {capturing() === item.id
                          ? 'Press keys…'
                          : props.settings.keybindings?.[item.id] === ''
                            ? 'Unbound'
                            : (props.settings.keybindings?.[item.id] ?? item.defaultKey)}
                      </button>
                      <button
                        type="button"
                        class="shortcut-clear"
                        aria-label={`Clear ${item.label} shortcut`}
                        onClick={() => setBinding(item.id, '')}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
              </For>
              <button
                type="button"
                class="reset-button"
                data-setting-id={settingItems.resetShortcuts.id}
                classList={{
                  'setting-row-highlighted': highlighted() === settingItems.resetShortcuts.id,
                }}
                onClick={() => update({ keybindings: {} })}
              >
                Restore default shortcuts
              </button>
            </section>
          </Show>
          <Show when={section() === 'Sessions'}>
            <section class="settings-group">
              <Row item={settingItems.saveHistory}>
                <input
                  type="checkbox"
                  aria-label="Save session history"
                  checked={persistence().enabled}
                  onChange={(e) => setPersistence({ enabled: e.currentTarget.checked })}
                />
              </Row>
              <Row item={settingItems.retention}>
                <input
                  type="number"
                  aria-label="Retention days"
                  min="1"
                  max="365"
                  value={persistence().retainDays}
                  onChange={(e) => {
                    const n = Number(e.currentTarget.value)
                    if (n >= 1 && n <= 365) setPersistence({ retainDays: n })
                  }}
                />
                <span class="unit">days</span>
              </Row>
              <Row item={settingItems.storageLimit}>
                <select
                  aria-label="Storage limit"
                  value={persistence().maxSessionBytes}
                  onChange={(e) =>
                    setPersistence({ maxSessionBytes: Number(e.currentTarget.value) })
                  }
                >
                  <option value={268435456}>256 MB</option>
                  <option value={1073741824}>1 GB</option>
                  <option value={2147483648}>2 GB</option>
                  <option value={4294967296}>4 GB</option>
                </select>
              </Row>
              <Row item={settingItems.recordInput}>
                <input
                  type="checkbox"
                  aria-label="Record input"
                  checked={persistence().persistInput}
                  onChange={(e) => setPersistence({ persistInput: e.currentTarget.checked })}
                />
              </Row>
            </section>
          </Show>
          <Show when={section() === 'Daemon'}>
            <section class="settings-group">
              <Row item={settingItems.daemonStatus}>
                <span class="daemon-state">{props.diagnostics?.state ?? 'Checking…'}</span>
              </Row>
              <Row
                item={settingItems.daemonRecovery}
                description={
                  props.diagnostics?.lastReason ??
                  props.diagnostics?.lastError ??
                  'The daemon keeps terminals alive independently of this window.'
                }
              >
                <Show
                  when={
                    props.diagnostics?.recoveryAction && props.diagnostics.recoveryAction !== 'none'
                  }
                >
                  <button
                    type="button"
                    disabled={props.recovering}
                    onClick={() => void props.onRecover(props.diagnostics!.recoveryAction)}
                  >
                    {props.recovering ? 'Working…' : 'Recover daemon'}
                  </button>
                </Show>
              </Row>
            </section>
            <Show when={props.recoverError}>
              <div class="settings-error" role="alert">
                {props.recoverError}
              </div>
            </Show>
          </Show>
        </div>
      </main>
    </div>
  )
}
