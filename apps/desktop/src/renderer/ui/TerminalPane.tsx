import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { TauTerminal } from '../tau-terminal'
import {
  clearTerminalSearch,
  createTerminal,
  detachTerminalSurface,
  forceTerminalRender,
  onTerminalSearchResults,
  searchTerminalBuffer,
  setTerminalCursorVisible,
} from '../terminal'

export function TerminalPane(props: {
  sessionId: string
  terminalId?: string
  cwd?: string
  argv?: readonly string[]
  isActive: boolean
  focusToken: number
  searchToken: number
  onTitleChange?(title: string): void
  onProcessTitleChange?(title: string): void
  onCwdChange?(cwd: string): void
  onExit?(): void
  onRestartSession?(): void
}) {
  let surface: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined
  let terminal: TauTerminal | null = null
  let lastSearchToken = 0
  const [error, setError] = createSignal('')
  const [opening, setOpening] = createSignal(true)
  const [archived, setArchived] = createSignal(false)
  const [searchVisible, setSearchVisible] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [result, setResult] = createSignal({ resultIndex: -1, resultCount: 0 })

  onMount(() => {
    let disposed = false
    let cleanupSearch: { dispose(): void } | undefined
    let frame: number | undefined
    let timer: number | undefined
    const sessionId = props.sessionId
    const renderShown = (instance: TauTerminal) => {
      void window.electronAPI.signalReady().then(() => {
        if (disposed || terminal !== instance) return
        forceTerminalRender(instance)
        frame = requestAnimationFrame(() => {
          if (!disposed && terminal === instance) forceTerminalRender(instance)
        })
        timer = window.setTimeout(() => {
          if (!disposed && terminal === instance) forceTerminalRender(instance)
        }, 50)
      })
    }
    void (async () => {
      try {
        if (!window.electronAPI || !surface) throw new Error('Terminal surface unavailable')
        const instance = await createTerminal(surface, sessionId, {
          terminalId: props.terminalId,
          cwd: props.cwd,
          argv: props.argv,
          onTitle: (title) => props.onTitleChange?.(title),
          onProcessTitle: (title) => props.onProcessTitleChange?.(title),
          onCwd: (cwd) => props.onCwdChange?.(cwd),
          onExit: () => props.onExit?.(),
          onArchived: () => {
            if (!disposed) setArchived(true)
          },
        })
        if (disposed) {
          detachTerminalSurface(sessionId, instance)
          return
        }
        terminal = instance
        setOpening(false)
        cleanupSearch = onTerminalSearchResults(instance, setResult)
        setTerminalCursorVisible(instance, props.isActive && !archived())
        if (props.isActive && !archived()) {
          instance.focus()
          renderShown(instance)
        } else instance.blur()
      } catch (cause) {
        if (disposed) return
        console.error('[renderer] Failed to initialize terminal', cause)
        setError(cause instanceof Error ? cause.message : String(cause))
        setOpening(false)
        if (props.isActive) void window.electronAPI.signalReady()
      }
    })()
    onCleanup(() => {
      disposed = true
      cleanupSearch?.dispose()
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timer !== undefined) clearTimeout(timer)
      detachTerminalSurface(sessionId, terminal)
      terminal = null
    })
  })

  createEffect(() => {
    const active = props.isActive && !archived()
    void props.focusToken
    if (!terminal) return
    setTerminalCursorVisible(terminal, active)
    if (active) {
      terminal.focus()
      forceTerminalRender(terminal)
    } else terminal.blur()
  })

  createEffect(() => {
    const token = props.searchToken
    if (token <= lastSearchToken || !props.isActive || archived()) return
    lastSearchToken = token
    setSearchVisible(true)
    requestAnimationFrame(() => {
      searchInput?.focus()
      searchInput?.select()
    })
  })

  createEffect(() => {
    if (!archived()) return
    if (terminal) clearTerminalSearch(terminal)
    setSearchVisible(false)
  })

  const runSearch = (text: string, direction: 'next' | 'previous', incremental = false) => {
    if (!terminal) return
    if (text) searchTerminalBuffer(terminal, text, direction, incremental)
    else {
      clearTerminalSearch(terminal)
      setResult({ resultIndex: -1, resultCount: 0 })
    }
  }
  const closeSearch = () => {
    if (terminal) {
      clearTerminalSearch(terminal)
      if (props.isActive && !archived()) terminal.focus()
    }
    setSearchVisible(false)
    setResult({ resultIndex: -1, resultCount: 0 })
  }
  const searchKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
    }
  }

  return (
    <div class="terminal-container">
      <div
        class="terminal-surface"
        ref={(element) => {
          surface = element
        }}
      />
      <Show when={opening() && !error() && !archived()}>
        <div class="terminal-opening" aria-live="polite">
          <span class="terminal-opening-dot" /> Opening terminal…
        </div>
      </Show>
      <Show when={searchVisible() && !archived() && !error()}>
        <form
          class="terminal-search-panel"
          onSubmit={(event) => {
            event.preventDefault()
            runSearch(query(), 'next')
          }}
        >
          <span aria-hidden="true">⌕</span>
          <input
            ref={(element) => {
              searchInput = element
            }}
            aria-label="Find in terminal"
            value={query()}
            placeholder="Find in terminal"
            spellcheck={false}
            onKeyDown={searchKey}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              runSearch(query(), 'next', true)
            }}
          />
          <span class="terminal-search-count" aria-live="polite">
            {query() ? `${result().resultIndex + 1}/${result().resultCount}` : ''}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={() => runSearch(query(), 'previous')}
            onKeyDown={searchKey}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            onClick={() => runSearch(query(), 'next')}
            onKeyDown={searchKey}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Close search"
            onClick={closeSearch}
            onKeyDown={searchKey}
          >
            ×
          </button>
        </form>
      </Show>
      <Show when={error()}>
        <div class="terminal-error">
          <h2>Failed to initialize terminal</h2>
          <pre>{error()}</pre>
        </div>
      </Show>
      <Show when={archived() && !error()}>
        <div class="terminal-archive-banner">
          Read-only archive · Input is disabled
          <button type="button" onClick={() => props.onRestartSession?.()}>
            Start fresh shell
          </button>
        </div>
      </Show>
    </div>
  )
}
