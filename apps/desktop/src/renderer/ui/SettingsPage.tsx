import { createSignal, For, onCleanup, Show } from 'solid-js'
import { defaultSettings, shortcuts } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'
import type {
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryAction,
} from '@tau/shared/taud-protocol'

type Section = 'Appearance' | 'Terminal' | 'Multiplexer' | 'Keyboard' | 'Sessions' | 'Daemon'
const sections: Section[] = [
  'Appearance',
  'Terminal',
  'Multiplexer',
  'Keyboard',
  'Sessions',
  'Daemon',
]

export function SettingsPage(props: {
  settings: SettingsData
  onChange(settings: SettingsData): Promise<void>
  onBack(): void
  diagnostics: TaudLifecycleDiagnostics | null
  recovering: boolean
  recoverError: string
  onRecover(action: TaudLifecycleRecoveryAction): Promise<void>
}) {
  const [section, setSection] = createSignal<Section>('Appearance')
  const [error, setError] = createSignal('')
  const [capturing, setCapturing] = createSignal<string | null>(null)
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
  const Row = (row: { title: string; description?: string; children: any }) => (
    <div class="setting-row">
      <div class="setting-copy">
        <strong>{row.title}</strong>
        <Show when={row.description}>
          <p>{row.description}</p>
        </Show>
      </div>
      <div class="setting-control">{row.children}</div>
    </div>
  )

  return (
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings navigation">
        <button class="settings-back" type="button" onClick={props.onBack}>
          ← <span>Terminal</span>
        </button>
        <For each={sections}>
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
        <select
          class="settings-section-select"
          aria-label="Settings section"
          value={section()}
          onChange={(event) => {
            capture(null)
            setSection(event.currentTarget.value as Section)
          }}
        >
          <For each={sections}>{(item) => <option value={item}>{item}</option>}</For>
        </select>
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
              <Row title="Color palette">
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
              <Row title="Accent">
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
              <Row title="Show sidebar">
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
              <Row
                title="Font size"
                description="Applies to every live terminal and refits the PTY grid."
              >
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
              <Row title="Font family">
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
              <Row
                title="Confirm before closing"
                description="Ask before closing a tab or pane. Closing a view never terminates its daemon session."
              >
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
                  <div class="setting-row shortcut-row">
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
                onClick={() => update({ keybindings: {} })}
              >
                Restore default shortcuts
              </button>
            </section>
          </Show>
          <Show when={section() === 'Sessions'}>
            <section class="settings-group">
              <Row
                title="Save session history"
                description="Retain output and snapshots so detached sessions can be recovered."
              >
                <input
                  type="checkbox"
                  aria-label="Save session history"
                  checked={persistence().enabled}
                  onChange={(e) => setPersistence({ enabled: e.currentTarget.checked })}
                />
              </Row>
              <Row
                title="Retention"
                description="Delete expired session history after this many days."
              >
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
              <Row title="Storage limit" description="Maximum on-disk bytes retained per session.">
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
              <Row
                title="Record input"
                description="Store keystrokes as well as output. May include secrets; off by default."
              >
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
              <Row
                title="Status"
                description="PTYs and session history are owned by the Zig daemon."
              >
                <span class="daemon-state">{props.diagnostics?.state ?? 'Checking…'}</span>
              </Row>
              <Row
                title="Recovery"
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
