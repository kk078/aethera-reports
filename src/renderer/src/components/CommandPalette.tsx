import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Client } from '../../../shared/domain'

export interface CommandItem {
  id: string
  label: string
  detail?: string
  group: string
  href: string
  keywords?: string[]
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  clients: Client[]
}

const NAV_ITEMS: Omit<CommandItem, 'id'>[] = [
  { label: 'Portfolio', group: 'Navigate', href: '/', keywords: ['home', 'dashboard'] },
  { label: 'Clients', group: 'Navigate', href: '/clients', keywords: ['practices'] },
  { label: 'Imports', group: 'Navigate', href: '/imports', keywords: ['csv', 'x12', 'data'] },
  { label: 'Manual Entry', group: 'Navigate', href: '/manual-entry', keywords: ['summary'] },
  { label: 'Denials', group: 'Analytics', href: '/denials', keywords: ['carc'] },
  { label: 'A/R', group: 'Analytics', href: '/ar', keywords: ['aging', 'receivable'] },
  { label: 'Payers', group: 'Analytics', href: '/payers', keywords: ['payer mix'] },
  { label: 'Automation', group: 'Operations', href: '/automation', keywords: ['scheduler', 'watch'] },
  { label: 'Settings', group: 'Operations', href: '/settings', keywords: ['branding', 'config'] }
]

function buildItems(clients: Client[]): CommandItem[] {
  const nav = NAV_ITEMS.map((item) => ({ ...item, id: `nav:${item.href}` }))
  const clientItems = clients
    .filter((c) => c.active)
    .flatMap((c) => [
      {
        id: `client:${c.clientId}`,
        label: c.name,
        detail: c.code,
        group: 'Clients',
        href: `/clients/${c.clientId}`,
        keywords: [c.code, c.name]
      },
      {
        id: `report:${c.clientId}`,
        label: `Report — ${c.name}`,
        detail: 'Open client report',
        group: 'Reports',
        href: `/clients/${c.clientId}`,
        keywords: [c.code, 'export', 'pdf']
      }
    ])
  return [...nav, ...clientItems]
}

function matchesQuery(item: CommandItem, query: string): boolean {
  if (!query) return true
  const haystack = [item.label, item.detail, item.group, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token))
}

export default function CommandPalette({
  open,
  onClose,
  clients
}: CommandPaletteProps): React.JSX.Element | null {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const items = useMemo(() => buildItems(clients), [clients])
  const filtered = useMemo(
    () => items.filter((item) => matchesQuery(item, query)),
    [items, query]
  )

  const runItem = useCallback(
    (item: CommandItem) => {
      navigate(item.href)
      onClose()
      setQuery('')
    },
    [navigate, onClose]
  )

  useEffect(() => {
    if (!open) return
    setActiveIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, query])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) =>
          filtered.length ? (i - 1 + filtered.length) % filtered.length : 0
        )
        return
      }
      if (e.key === 'Enter' && filtered[activeIndex]) {
        e.preventDefault()
        runItem(filtered[activeIndex])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, filtered, activeIndex, runItem, onClose])

  if (!open) return null

  let lastGroup = ''

  return (
    <div className="command-palette-backdrop" onClick={onClose} role="presentation">
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          type="search"
          placeholder="Search clients, screens, actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-controls="command-palette-list"
          aria-activedescendant={
            filtered[activeIndex] ? `command-item-${filtered[activeIndex].id}` : undefined
          }
        />
        <ul id="command-palette-list" className="command-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="command-palette-empty">No matches</li>
          ) : (
            filtered.map((item, index) => {
              const showGroup = item.group !== lastGroup
              lastGroup = item.group
              return (
                <li key={item.id} role="presentation">
                  {showGroup && <div className="command-palette-group">{item.group}</div>}
                  <button
                    id={`command-item-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'command-palette-item active' : 'command-palette-item'}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runItem(item)}
                  >
                    <span className="command-palette-item-label">{item.label}</span>
                    {item.detail && (
                      <span className="command-palette-item-detail">{item.detail}</span>
                    )}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </div>
  )
}

/** Global ⌘K / Ctrl+K listener — attach once in AppLayout. */
export function useCommandPaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpen])
}
