import { createSignal, For, onCleanup, Show } from 'solid-js'
import { defaultSettings, shortcuts } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'
import type {
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryAction,
} from '@tau/shared/taud-protocol'

type Section = 'Appearance' | 'Terminal' | 'Multiplexer' | 'Keyboard' | 'Sessions' | 'Daemon'
const sections: { name: Section; icon: string; description: string }[] = [
  { name: 'Appearance', icon: '◈', description: 'Make Tau your own' },
  { name: 'Terminal', icon: '⌘', description: 'Type, scale and canvas' },
  { name: 'Multiplexer', icon: '▦', description: 'Tabs and pane behavior' },
  { name: 'Keyboard', icon: '⌨', description: 'Shortcuts and navigation' },
  { name: 'Sessions', icon: '◷', description: 'History and retention' },
  { name: 'Daemon', icon: '◉', description: 'Connection and recovery' },
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
  const Row = (row: { title: string; description: string; children: any }) => (
    <div class="setting-row">
      <div class="setting-copy">
        <strong>{row.title}</strong>
        <p>{row.description}</p>
      </div>
      <div class="setting-control">{row.children}</div>
    </div>
  )
  const Card = (card: { title: string; children: any }) => (
    <section class="settings-card">
      <h2>{card.title}</h2>
      {card.children}
    </section>
  )
  const selected = () => sections.find((item) => item.name === section())!

  return (
    <div class="settings-layout">
      <nav class="settings-nav glass" aria-label="Settings navigation">
        <button class="settings-back" type="button" onClick={props.onBack}>
          ← <span>Back to terminal</span>
        </button>
        <div class="settings-nav-heading">PREFERENCES</div>
        <For each={sections}>
          {(item) => (
            <button
              type="button"
              class="settings-nav-item"
              classList={{ current: section() === item.name }}
              onClick={() => {
                capture(null)
                setSection(item.name)
              }}
              aria-current={section() === item.name ? 'page' : undefined}
            >
              <span class="settings-nav-icon">{item.icon}</span>
              {item.name}
            </button>
          )}
        </For>
        <div class="settings-nav-version">TAU / PREFERENCES</div>
      </nav>
      <main class="settings-main" aria-label="Settings">
        <div class="settings-content">
          <div class="eyebrow">CONFIGURATION / {section().toUpperCase()}</div>
          <h1>{selected().name}</h1>
          <p class="settings-lead">{selected().description}</p>
          <Show when={error()}>
            <div class="settings-error" role="alert">
              {error()}
            </div>
          </Show>
          <Show when={section() === 'Appearance'}>
            <Card title="Interface">
              <Row
                title="Color palette"
                description="Choose the depth of the interface around your terminal."
              >
                <select
                  aria-label="Color palette"
                  value={appearance().theme}
                  onChange={(e) =>
                    setAppearance({ theme: e.currentTarget.value as 'midnight' | 'slate' })
                  }
                >
                  <option value="midnight">Midnight glass</option>
                  <option value="slate">Slate glass</option>
                </select>
              </Row>
              <Row title="Accent" description="Selection, focus and active workspace highlight.">
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
              <Row title="Workspace sidebar" description="Show your open tabs in a vertical rail.">
                <input
                  type="checkbox"
                  aria-label="Workspace sidebar"
                  checked={appearance().sidebar}
                  onChange={(e) => setAppearance({ sidebar: e.currentTarget.checked })}
                />
              </Row>
            </Card>
          </Show>
          <Show when={section() === 'Terminal'}>
            <Card title="Display">
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
              <Row title="Font family" description="Choose a locally installed monospace family.">
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
            </Card>
          </Show>
          <Show when={section() === 'Multiplexer'}>
            <Card title="Pane behavior">
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
            </Card>
            <div class="settings-note">
              Tabs and splits live in the daemon mux graph. Restarting the window reattaches to live
              sessions.
            </div>
          </Show>
          <Show when={section() === 'Keyboard'}>
            <Card title="Shortcuts">
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
            </Card>
          </Show>
          <Show when={section() === 'Sessions'}>
            <Card title="Persistence">
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
            </Card>
          </Show>
          <Show when={section() === 'Daemon'}>
            <Card title="Terminal service">
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
            </Card>
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
