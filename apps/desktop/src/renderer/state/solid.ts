import { createSignal, onCleanup } from 'solid-js'
import { useTauStore, type TauState } from './store'

/** Solid tracks only the selected slice; terminal output never touches this store. */
export function useTau<T>(select: (state: TauState) => T): () => T {
  const [value, setValue] = createSignal(select(useTauStore.getState()))
  const unsubscribe = useTauStore.subscribe((state) => {
    const next = select(state)
    setValue(() => next)
  })
  onCleanup(unsubscribe)
  return value
}
