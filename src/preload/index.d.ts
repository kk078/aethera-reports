import type { AetheraApi } from './index'

declare global {
  interface Window {
    aethera: AetheraApi
  }
}
