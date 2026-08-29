/**
 * Global analytics scope — period and optional client filter shared across
 * screens (Google Analytics-style property + date range bar).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { Client } from '../../../shared/domain'
import { currentMonthValue } from '../../../shared/format'
import { listClients } from './api'

const STORAGE_KEY = 'aethera-app-scope'

interface StoredScope {
  period: string
  clientId: number | null
}

interface AppScopeValue {
  period: string
  setPeriod: (period: string) => void
  clientId: number | null
  setClientId: (clientId: number | null) => void
  clients: Client[]
  clientsLoading: boolean
  clientsError: string | null
  refreshClients: () => Promise<void>
}

const AppScopeContext = createContext<AppScopeValue | null>(null)

function readStoredScope(): StoredScope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { period: currentMonthValue(), clientId: null }
    const parsed = JSON.parse(raw) as Partial<StoredScope>
    return {
      period:
        typeof parsed.period === 'string' && /^\d{4}-\d{2}$/.test(parsed.period)
          ? parsed.period
          : currentMonthValue(),
      clientId: typeof parsed.clientId === 'number' ? parsed.clientId : null
    }
  } catch {
    return { period: currentMonthValue(), clientId: null }
  }
}

export function AppScopeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const initial = readStoredScope()
  const [period, setPeriodState] = useState(initial.period)
  const [clientId, setClientIdState] = useState<number | null>(initial.clientId)
  const [clients, setClients] = useState<Client[]>([])
  const [clientsLoading, setClientsLoading] = useState(true)
  const [clientsError, setClientsError] = useState<string | null>(null)

  const refreshClients = useCallback(async () => {
    setClientsLoading(true)
    setClientsError(null)
    try {
      const all = await listClients()
      setClients(all)
      setClientIdState((prev) => {
        if (prev !== null && !all.some((c) => c.clientId === prev && c.active)) return null
        return prev
      })
    } catch (err) {
      setClientsError(String(err))
    } finally {
      setClientsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshClients()
  }, [refreshClients])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ period, clientId }))
  }, [period, clientId])

  const setPeriod = useCallback((next: string) => setPeriodState(next), [])
  const setClientId = useCallback((next: number | null) => setClientIdState(next), [])

  const value = useMemo(
    (): AppScopeValue => ({
      period,
      setPeriod,
      clientId,
      setClientId,
      clients,
      clientsLoading,
      clientsError,
      refreshClients
    }),
    [period, setPeriod, clientId, setClientId, clients, clientsLoading, clientsError, refreshClients]
  )

  return <AppScopeContext.Provider value={value}>{children}</AppScopeContext.Provider>
}

export function useAppScope(): AppScopeValue {
  const ctx = useContext(AppScopeContext)
  if (!ctx) throw new Error('useAppScope must be used within AppScopeProvider')
  return ctx
}
