// Persisted central server state: enrolled machines, paired devices, web push keys and subscriptions,
// speech settings. Only sha256 hashes of tokens are stored; speech provider API keys are stored as given
// (they must be sent upstream) and never returned by the API. The file is private (dir 0700, file 0600)
// and written atomically.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { StoredSpeech } from "./speech/settings"

export interface MachineRecord {
  id: string
  name: string
  tokenHash: string
  created: number
  lastSeen: number
  revoked?: boolean
}

/** Which notifications a device wants. */
export interface PushPrefs {
  handoff: boolean
  blocked: boolean
  finished: boolean
  /** Conversation mode replies while no device is watching the session. */
  say: boolean
}

export const DEFAULT_PUSH_PREFS: Readonly<PushPrefs> = Object.freeze({ handoff: true, blocked: true, finished: false, say: true })

export interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  created: number
  lastSeen: number
  pushPrefs?: Partial<PushPrefs>
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushSubscriptionRecord {
  deviceID: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  created: number
}

export interface StateData {
  machines: MachineRecord[]
  devices: DeviceRecord[]
  vapid?: VapidKeys
  push: PushSubscriptionRecord[]
  speech?: StoredSpeech
}

/** Writes of lastSeen alone are throttled to this interval. */
const TOUCH_PERSIST_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export const newToken = (): string => randomBytes(32).toString("base64url")
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")
export const newID = (prefix: string): string => `${prefix}_${randomBytes(9).toString("base64url")}`

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

function findByToken<T extends { tokenHash: string }>(records: readonly T[], token: string): T | undefined {
  if (!token) return undefined
  const hash = hashToken(token)
  let found: T | undefined
  // Compare against every record so timing does not reveal the position of a match.
  for (const record of records) if (sameHash(record.tokenHash, hash)) found = record
  return found
}

export class Store {
  private constructor(
    private readonly file: string,
    private readonly state: StateData,
    private readonly now: () => number,
  ) {}

  static open(dir: string, now: () => number = Date.now): Store {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const file = path.join(dir, "state.json")
    let state: StateData = { machines: [], devices: [], push: [] }
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StateData>
        state = {
          machines: Array.isArray(raw.machines) ? raw.machines : [],
          devices: Array.isArray(raw.devices) ? raw.devices : [],
          ...(raw.vapid ? { vapid: raw.vapid } : {}),
          push: Array.isArray(raw.push) ? raw.push : [],
          ...(isRecord(raw.speech) ? { speech: raw.speech } : {}),
        }
      } catch (cause) {
        throw new Error(`Cannot read ${file}: ${cause instanceof Error ? cause.message : cause}. Fix or move it away.`)
      }
    }
    const store = new Store(file, state, now)
    store.save()
    return store
  }

  data(): Readonly<StateData> {
    return this.state
  }

  machines(): readonly MachineRecord[] {
    return this.state.machines
  }

  devices(): readonly DeviceRecord[] {
    return this.state.devices
  }

  addMachine(name: string): { machine: MachineRecord; token: string } {
    const token = newToken()
    const t = this.now()
    const machine: MachineRecord = { id: newID("mch"), name, tokenHash: hashToken(token), created: t, lastSeen: t }
    this.state.machines.push(machine)
    this.save()
    return { machine, token }
  }

  /** Non-revoked machine for a bearer token. */
  findMachine(token: string): MachineRecord | undefined {
    return findByToken(
      this.state.machines.filter((machine) => !machine.revoked),
      token,
    )
  }

  revokeMachine(id: string): boolean {
    const machine = this.state.machines.find((m) => m.id === id)
    if (!machine || machine.revoked) return false
    machine.revoked = true
    this.save()
    return true
  }

  touchMachine(id: string): void {
    this.touch(this.state.machines.find((m) => m.id === id))
  }

  addDevice(name: string): { device: DeviceRecord; token: string } {
    const token = newToken()
    const t = this.now()
    const device: DeviceRecord = { id: newID("dev"), name, tokenHash: hashToken(token), created: t, lastSeen: t }
    this.state.devices.push(device)
    this.save()
    return { device, token }
  }

  findDevice(token: string): DeviceRecord | undefined {
    return findByToken(this.state.devices, token)
  }

  removeDevice(id: string): boolean {
    const before = this.state.devices.length
    this.state.devices = this.state.devices.filter((d) => d.id !== id)
    if (this.state.devices.length === before) return false
    this.state.push = this.state.push.filter((p) => p.deviceID !== id)
    this.save()
    return true
  }

  // ---------- web push ----------

  vapid(): VapidKeys | undefined {
    return this.state.vapid
  }

  setVapid(keys: VapidKeys): void {
    this.state.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey }
    this.save()
  }

  pushSubscriptions(): readonly PushSubscriptionRecord[] {
    return this.state.push
  }

  /** Adds or replaces (by endpoint) a subscription; an endpoint belongs to one device. */
  addPushSubscription(deviceID: string, target: PushTarget): PushSubscriptionRecord {
    const record: PushSubscriptionRecord = {
      deviceID,
      endpoint: target.endpoint,
      keys: { p256dh: target.keys.p256dh, auth: target.keys.auth },
      created: this.now(),
    }
    const index = this.state.push.findIndex((p) => p.endpoint === target.endpoint)
    if (index >= 0) this.state.push[index] = record
    else this.state.push.push(record)
    this.save()
    return record
  }

  /** Removes a device's own subscription. */
  removePushSubscription(deviceID: string, endpoint: string): boolean {
    return this.dropPush((p) => p.deviceID === deviceID && p.endpoint === endpoint)
  }

  /** Removes a subscription the push service reported as gone. */
  dropPushSubscription(endpoint: string): boolean {
    return this.dropPush((p) => p.endpoint === endpoint)
  }

  pushPrefs(deviceID: string): PushPrefs {
    const device = this.state.devices.find((d) => d.id === deviceID)
    return { ...DEFAULT_PUSH_PREFS, ...device?.pushPrefs }
  }

  setPushPrefs(deviceID: string, prefs: Partial<PushPrefs>): PushPrefs {
    const device = this.state.devices.find((d) => d.id === deviceID)
    if (!device) return { ...DEFAULT_PUSH_PREFS }
    const next = this.pushPrefs(deviceID)
    for (const key of Object.keys(DEFAULT_PUSH_PREFS) as Array<keyof PushPrefs>) {
      if (typeof prefs[key] === "boolean") next[key] = prefs[key]
    }
    device.pushPrefs = next
    this.save()
    return { ...next }
  }

  private dropPush(match: (record: PushSubscriptionRecord) => boolean): boolean {
    const before = this.state.push.length
    this.state.push = this.state.push.filter((p) => !match(p))
    if (this.state.push.length === before) return false
    this.save()
    return true
  }

  // ---------- speech settings ----------

  /** A copy of the stored speech settings (callers may not mutate the state). */
  speechSettings(): StoredSpeech {
    return structuredClone(this.state.speech ?? {})
  }

  setSpeechSettings(settings: StoredSpeech): void {
    this.state.speech = structuredClone(settings)
    this.save()
  }

  touchDevice(id: string): void {
    this.touch(this.state.devices.find((d) => d.id === id))
  }

  private touch(record: { lastSeen: number } | undefined): void {
    if (!record) return
    const t = this.now()
    if (t - record.lastSeen < TOUCH_PERSIST_MS) return
    record.lastSeen = t
    this.save()
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
