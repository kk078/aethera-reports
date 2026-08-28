/**
 * The preload bridge — the ONLY code that runs with both Node access and
 * a `window` object (plan §7). It exposes exactly one function to the
 * renderer: a typed `invoke(channel, payload)`. There is no raw
 * `ipcRenderer`, no `require`, no filesystem access exposed — the
 * renderer can only ever ask for one of the channels declared in
 * `src/shared/ipc-contract.ts`, and the main process re-validates
 * whatever comes through regardless.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc-contract'

async function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>
): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, payload)
}

const aetheraApi = { invoke }

export type AetheraApi = typeof aetheraApi

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('aethera', aetheraApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // contextIsolation is always on for this app (plan §7); this branch
  // only exists so preload doesn't throw if it's ever accidentally
  // disabled during local debugging.
  // @ts-ignore (window.aethera is declared in index.d.ts; the node
  // tsconfig's glob doesn't pick up sibling .d.ts files, unlike web's)
  window.aethera = aetheraApi
}
