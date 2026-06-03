import type { MosaicNode, MosaicSplitNode, MosaicTabsNode } from 'react-mosaic-component'

export type MosaicLayoutNode = MosaicNode<string>
export type MosaicSplitLayoutNode = MosaicSplitNode<string>
export type MosaicTabsLayoutNode = MosaicTabsNode<string>

export type PaneBounds = {
  left: number
  top: number
  right: number
  bottom: number
}

export type PaneRect = PaneBounds & {
  id: string
}

export function isSplitNode(node: MosaicLayoutNode): node is MosaicSplitLayoutNode {
  return typeof node === 'object' && node !== null && node.type === 'split'
}

export function isTabsNode(node: MosaicLayoutNode): node is MosaicTabsLayoutNode {
  return typeof node === 'object' && node !== null && node.type === 'tabs'
}

export function equalSplitPercentages(count: number): number[] {
  if (count <= 0) return []
  const percentage = 100 / count
  return Array.from({ length: count }, () => percentage)
}

export function normalizeSplitPercentages(
  values: readonly unknown[] | undefined,
  count: number,
): number[] {
  if (count <= 0) return []
  if (!values || values.length !== count) return equalSplitPercentages(count)

  const percentages = values.map((value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0,
  )
  const total = percentages.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return equalSplitPercentages(count)

  return percentages.map((value) => (value / total) * 100)
}

export function splitPercentagesForLayout(layout: MosaicSplitLayoutNode): number[] {
  return normalizeSplitPercentages(layout.splitPercentages, layout.children.length)
}

export function activeTabId(layout: MosaicTabsLayoutNode): string | null {
  return layout.tabs[layout.activeTabIndex] ?? layout.tabs[0] ?? null
}

export function activeTabIndexForTabs(
  tabs: readonly string[],
  preferredActiveTabId: string | null | undefined,
  fallbackIndex: number | undefined,
): number {
  if (tabs.length <= 0) return 0

  if (preferredActiveTabId) {
    const preferredIndex = tabs.indexOf(preferredActiveTabId)
    if (preferredIndex >= 0) return preferredIndex
  }

  const finiteFallback =
    typeof fallbackIndex === 'number' && Number.isFinite(fallbackIndex) ? fallbackIndex : 0
  return Math.min(tabs.length - 1, Math.max(0, Math.trunc(finiteFallback)))
}

export function getPaneIdsInLayout(layout: MosaicLayoutNode): string[] {
  if (typeof layout === 'string') return [layout]
  if (isSplitNode(layout)) return layout.children.flatMap(getPaneIdsInLayout)
  if (isTabsNode(layout)) return [...layout.tabs]
  return []
}

export function layoutContainsPane(layout: MosaicLayoutNode, paneId: string): boolean {
  return getPaneIdsInLayout(layout).includes(paneId)
}

export function getFirstPaneId(layout: MosaicLayoutNode): string | null {
  if (typeof layout === 'string') return layout
  if (isSplitNode(layout)) {
    for (const child of layout.children) {
      const paneId = getFirstPaneId(child)
      if (paneId) return paneId
    }
    return null
  }
  if (isTabsNode(layout)) return activeTabId(layout)
  return null
}

export function getPaneCount(layout: MosaicLayoutNode): number {
  return getPaneIdsInLayout(layout).length
}

export function getPaneRects(
  layout: MosaicLayoutNode,
  bounds: PaneBounds = { left: 0, top: 0, right: 100, bottom: 100 },
): PaneRect[] {
  if (typeof layout === 'string') return [{ id: layout, ...bounds }]

  if (isTabsNode(layout)) {
    const paneId = activeTabId(layout)
    return paneId ? [{ id: paneId, ...bounds }] : []
  }

  if (!isSplitNode(layout)) return []

  const percentages = splitPercentagesForLayout(layout)
  let offset = layout.direction === 'row' ? bounds.left : bounds.top
  const extent =
    layout.direction === 'row' ? bounds.right - bounds.left : bounds.bottom - bounds.top

  return layout.children.flatMap((child, index) => {
    const nextOffset =
      index === layout.children.length - 1
        ? layout.direction === 'row'
          ? bounds.right
          : bounds.bottom
        : offset + extent * ((percentages[index] ?? 0) / 100)
    const childBounds =
      layout.direction === 'row'
        ? { ...bounds, left: offset, right: nextOffset }
        : { ...bounds, top: offset, bottom: nextOffset }
    offset = nextOffset
    return getPaneRects(child, childBounds)
  })
}

export function getVisiblePaneIdForPane(layout: MosaicLayoutNode, paneId: string): string | null {
  if (typeof layout === 'string') return layout === paneId ? paneId : null

  if (isTabsNode(layout)) {
    if (!layout.tabs.includes(paneId)) return null
    return activeTabId(layout)
  }

  if (isSplitNode(layout)) {
    for (const child of layout.children) {
      const visiblePaneId = getVisiblePaneIdForPane(child, paneId)
      if (visiblePaneId) return visiblePaneId
    }
  }

  return null
}
