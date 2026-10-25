// A single-process hub's state directory in an older format, for the `hub-server import` tests.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/central/backend/file-state"
import { hashToken } from "../src/central/store"

export const MACHINE_TOKEN = "machine-token-0123456789abcdef"
export const DEVICE_TOKEN = "device-token-0123456789abcdef"
export const TOKEN_KEYS = { active: "k_new", keys: [{ kid: "k_old", secret: Buffer.alloc(32, 1).toString("base64"), created: 1 }, { kid: "k_new", secret: Buffer.alloc(32, 2).toString("base64"), created: 2 }] }

/** An older single-process hub's state directory: state.json in an old format, agent files, signing keys. */
export async function fixtureStateDir(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-import-"))
  const state = {
    users: [
      { id: "u_alice", email: "alice@example.com", role: "admin", created: 2, lastSeen: 20, agent: { names: [{ name: "api", sessionID: "ses_1" }], generations: { "reviewer\u0000hub": 3 } }, tokenEpoch: 2 },
      { id: "u_bob", email: "bob@example.com", role: "user", created: 3, lastSeen: 30, disabled: true },
    ],
    // No ownerID (before 0.3.0): the upgrade gives it to the local user.
    machines: [{ id: "mch_laptop", name: "laptop", tokenHash: hashToken(MACHINE_TOKEN), created: 4, lastSeen: 40 }],
    // Legacy push prefs (0.5.0): upgraded to the current toggles.
    devices: [{ id: "dev_phone", name: "phone", tokenHash: hashToken(DEVICE_TOKEN), created: 5, lastSeen: 50, ownerID: "u_alice", pushPrefs: { blocked: true, finished: false } }],
    vapid: { publicKey: "vapid-public", privateKey: "vapid-private" },
    push: [{ deviceID: "dev_phone", endpoint: "https://push.example.com/1", keys: { p256dh: "p", auth: "a" }, created: 6 }],
    speech: { tts: { provider: "openrouter", model: "tts-1" } },
    audit: [
      { at: 100, actor: "u_alice", action: "device.pair", target: "dev_phone" },
      { at: 100, actor: "system", action: "machine.enroll", target: "mch_laptop" },
      { at: 101, actor: "u_alice", action: "grant.create" },
    ],
    agentsActingPaused: true,
  }
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
  const files = new FileStateStore({ stateDir: dir })
  await files.put("u_alice", "grants", "g_0123456789abcdef", { id: "g_0123456789abcdef", owner: "u_alice", holder: "@@reviewer" })
  await files.put("u_alice", "grants", "g_0123456789abcdef", { id: "g_0123456789abcdef", owner: "u_alice", holder: "@@reviewer", updated: 9 })
  await files.put("u_alice", "launches", "lch_1", { id: "lch_1", state: "running" })
  await files.put("u_alice", "messages", "m_1", { id: "m_1", kind: "msg", text: "hello" })
  await files.put("Bob@Example.com", "messages", "m_2", { id: "m_2", kind: "ask", text: "ok?" })
  await files.claim("names", "u_alice/api", "ses_1")
  await files.flush()
  writeFileSync(path.join(dir, "token-keys.json"), JSON.stringify(TOKEN_KEYS))
  return dir
}

