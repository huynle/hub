// Exactly one active spoke per OpenCode process. Every plugin instance in the process (one per
// location, plus reloads) joins a registry on globalThis; the first one creates the spoke, the
// others stay passive and delegate to it. When the active instance is disposed, the next
// instance takes over with its own factory, so a reloaded module replaces stale code.
import { randomBytes } from "node:crypto"

export interface Startable {
  start(): void
  stop(): void
}

interface Instance {
  readonly id: symbol
  readonly create: (processID: string) => Startable
}

interface Registry {
  pid: number
  processID: string
  instances: Instance[]
  spoke?: Startable
  owner?: symbol
}

export interface Membership<S> {
  readonly processID: string
  active(): S | undefined
  isActive(): boolean
  leave(): void
}

// Kept from opencode-voice so a process that loads both the old and the renamed package runs one spoke.
export const SPOKE_KEY = Symbol.for("opencode-voice.spoke")

function registry(key: symbol): Registry {
  const store = globalThis as Record<symbol, Registry | undefined>
  let reg = store[key]
  if (!reg || reg.pid !== process.pid || !Array.isArray(reg.instances)) {
    reg = { pid: process.pid, processID: `proc_${randomBytes(8).toString("hex")}`, instances: [] }
    store[key] = reg
  }
  return reg
}

function promote(reg: Registry): void {
  for (const instance of reg.instances) {
    try {
      const spoke = instance.create(reg.processID)
      spoke.start()
      reg.spoke = spoke
      reg.owner = instance.id
      return
    } catch (cause) {
      console.error("[hub] could not start the hub spoke", cause)
    }
  }
  reg.spoke = undefined
  reg.owner = undefined
}

/** `create` receives the stable per-process ID. */
export function joinProcess<S extends Startable>(create: (processID: string) => S, key: symbol = SPOKE_KEY): Membership<S> {
  const reg = registry(key)
  const id = Symbol("hub.instance")
  reg.instances.push({ id, create })
  if (!reg.spoke) {
    try {
      const spoke = create(reg.processID)
      spoke.start()
      reg.spoke = spoke
      reg.owner = id
    } catch (cause) {
      console.error("[hub] could not start the hub spoke", cause)
    }
  }
  return {
    processID: reg.processID,
    active: () => registry(key).spoke as S | undefined,
    isActive: () => registry(key).owner === id,
    leave: () => {
      const current = registry(key)
      const index = current.instances.findIndex((i) => i.id === id)
      if (index === -1) return
      current.instances.splice(index, 1)
      if (current.owner !== id) return
      try {
        current.spoke?.stop()
      } catch (cause) {
        console.error("[hub] spoke stop failed", cause)
      }
      promote(current)
    },
  }
}
