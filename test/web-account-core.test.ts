// Multi-user hub (0.3.0) in the PWA: account menu, sign-in screen, per-user speech inheritance, admin tables, audit.
import { describe, expect, test } from "bun:test"
import {
  account,
  adminError,
  approveOwner,
  auditLabel,
  auditRows,
  menuItems,
  resetPatch,
  signInURL,
  speechInheritance,
  speechTabs,
  userActions,
  usersView,
  type AdminUser,
  type Me,
} from "../web/account-core.js"

const alice: Me = { device: { id: "dev_a", name: "Pixel" }, user: { id: "u_alice", email: "alice@example.com", name: "Alice Example", role: "admin" }, auth: "oidc" }
const bob: Me = { device: { id: "dev_b", name: "iPhone" }, user: { id: "u_bob", email: "bob@example.com", role: "user" }, auth: "oidc" }
const local: Me = { device: { id: "dev_l", name: "Chrome" }, user: { id: "local", role: "admin" }, auth: "pairing" }

describe("account", () => {
  test("oidc admin: name, email, initial, Admin badge", () => {
    expect(account(alice)).toEqual({ mode: "oidc", admin: true, title: "Alice Example", subtitle: "alice@example.com", initial: "A", badge: "Admin" })
  })

  test("oidc user without a name: email is the title, no badge", () => {
    expect(account(bob)).toEqual({ mode: "oidc", admin: false, title: "bob@example.com", initial: "B" })
  })

  test("pairing mode: 'This hub', admin without a badge", () => {
    expect(account(local)).toEqual({ mode: "pairing", admin: true, title: "This hub", initial: "H" })
  })

  test("older hub without a user: pairing, not admin", () => {
    expect(account({ device: { id: "d", name: "x" } })).toEqual({ mode: "pairing", admin: false, title: "This hub", initial: "H" })
  })
})

describe("menuItems", () => {
  test("admins get Admin; everyone gets devices, speech and sign out", () => {
    expect(menuItems(alice).map((i) => i.id)).toEqual(["devices", "speech", "admin", "signout"])
    expect(menuItems(bob).map((i) => i.id)).toEqual(["devices", "speech", "signout"])
    expect(menuItems(bob)[0]).toEqual({ id: "devices", label: "My devices" })
  })
})

describe("speechTabs", () => {
  test("admins on a per-user hub get the server default tab", () => {
    expect(speechTabs(alice, { scope: "user" })).toEqual(["user", "default"])
    expect(speechTabs(bob, { scope: "user" })).toEqual(["user"])
  })

  test("a hub without per-user speech: one tab", () => {
    expect(speechTabs(alice, {})).toEqual(["user"])
  })
})

describe("signInURL", () => {
  test("adds the same-origin next path", () => {
    expect(signInURL({ mode: "oidc", signIn: "/auth/login" }, "/s/ses_1?x=1")).toBe("/auth/login?next=%2Fs%2Fses_1%3Fx%3D1")
  })

  test("unsafe or missing next becomes /", () => {
    expect(signInURL({ mode: "oidc", signIn: "/auth/login" }, "//evil.example")).toBe("/auth/login?next=%2F")
    expect(signInURL({ mode: "oidc", signIn: "/auth/login" }, undefined)).toBe("/auth/login?next=%2F")
  })

  test("pairing mode or no sign-in: undefined", () => {
    expect(signInURL({ mode: "pairing", signIn: null }, "/")).toBeUndefined()
    expect(signInURL(undefined, "/")).toBeUndefined()
  })
})

describe("speechInheritance", () => {
  const def = {
    stt: { provider: "openrouter", model: "openai/whisper-1", language: "en", apiKey: { set: true, last4: "abcd", source: "settings" } },
    tts: { provider: "openai-compatible", model: "tts-1", voice: "alloy", baseURL: "http://kokoro:8880/v1", apiKey: { set: false, source: "none" } },
  }

  test("not a per-user response: undefined (no indicators)", () => {
    expect(speechInheritance({ stt: def.stt, tts: def.tts })).toBeUndefined()
  })

  test("with the user's own fields: own vs inherited per field and key", () => {
    const settings = {
      scope: "user",
      stt: { ...def.stt, model: "openai/gpt-4o-transcribe" },
      tts: { ...def.tts, apiKey: { set: true, last4: "wxyz", source: "user" } },
      default: def,
      user: { stt: { model: "openai/gpt-4o-transcribe" }, tts: { apiKey: { set: true, last4: "wxyz", source: "user" } } },
    }
    const inh = speechInheritance(settings)!
    expect(inh.stt.model).toEqual({ inherited: false })
    expect(inh.stt.provider).toEqual({ inherited: true, note: "Using server default: openrouter" })
    expect(inh.stt.language).toEqual({ inherited: true, note: "Using server default: en" })
    expect(inh.stt.baseURL).toEqual({ inherited: true, note: "Server default: not set" })
    expect(inh.stt.apiKey).toEqual({ inherited: true, note: "Key: server default" })
    expect(inh.tts.apiKey).toEqual({ inherited: false })
    expect(inh.tts.voice).toEqual({ inherited: true, note: "Using server default: alloy" })
    expect(inh.own).toEqual({ stt: 1, tts: 1 })
  })

  test("without the user's fields: equal to the default means inherited; key by source", () => {
    const settings = {
      scope: "user",
      stt: { ...def.stt, model: "openai/gpt-4o-transcribe" },
      tts: { ...def.tts, apiKey: { set: true, last4: "wxyz", source: "user" } },
      default: def,
    }
    const inh = speechInheritance(settings)!
    expect(inh.stt.model.inherited).toBe(false)
    expect(inh.stt.provider.inherited).toBe(true)
    expect(inh.stt.apiKey.inherited).toBe(true)
    expect(inh.tts.apiKey.inherited).toBe(false)
    expect(inh.own).toEqual({ stt: 1, tts: 1 })
  })

  test("no server default key: the note says so", () => {
    const settings = { scope: "user", stt: { ...def.stt, apiKey: { set: false, source: "none" } }, tts: def.tts, default: { ...def, stt: { ...def.stt, apiKey: { set: false, source: "none" } } }, user: {} }
    expect(speechInheritance(settings)!.stt.apiKey).toEqual({ inherited: true, note: "Key: server default (none set)" })
  })
})

describe("resetPatch", () => {
  test("every field of the section null, key included", () => {
    expect(resetPatch("stt")).toEqual({ stt: { provider: null, model: null, baseURL: null, language: null, apiKey: null } })
    expect(resetPatch("tts")).toEqual({ tts: { provider: null, model: null, voice: null, baseURL: null, speed: null, apiKey: null } })
  })
})

describe("auditLabel / auditRows", () => {
  test("known actions read as sentences; unknown ones are humanized", () => {
    expect(auditLabel("machine.approve")).toBe("Approved a machine")
    expect(auditLabel("signin.denied")).toBe("Sign-in refused")
    expect(auditLabel("user.role")).toBe("Changed a role")
    expect(auditLabel("token.rotate_all")).toBe("Token rotate all")
    expect(auditLabel("")).toBe("Unknown action")
  })

  test("newest first, actor and user targets resolved to emails, System for system", () => {
    const users = [{ id: "u_alice", email: "alice@example.com" }, { id: "u_bob", email: "bob@example.com" }]
    const rows = auditRows(
      [
        { at: 1000, actor: "u_alice", action: "user.role", target: "u_bob", detail: "admin" },
        { at: 3000, actor: "system", action: "migrate.local" },
        { at: 2000, actor: "u_gone", action: "machine.revoke", target: "mac_1" },
      ],
      users,
    )
    expect(rows).toEqual([
      { at: 3000, actor: "System", action: "Moved the hub owner's machines and devices to the first admin", target: undefined, detail: undefined },
      { at: 2000, actor: "u_gone", action: "Revoked a machine", target: "mac_1", detail: undefined },
      { at: 1000, actor: "alice@example.com", action: "Changed a role", target: "bob@example.com", detail: "admin" },
    ])
  })
})

describe("usersView", () => {
  const users: AdminUser[] = [
    { id: "u_b", email: "bob@example.com", role: "user", created: 1, lastSeen: 500, machines: 1, devices: 2 },
    { id: "u_a", email: "alice@example.com", name: "Alice", role: "admin", created: 1, lastSeen: 900, machines: 2, devices: 1 },
    { id: "u_c", email: "carol@example.com", name: "Carol", role: "user", disabled: true, created: 1, lastSeen: 100, machines: 0, devices: 0 },
  ]

  test("default sort: admins first, then by email", () => {
    expect(usersView(users).map((u) => u.id)).toEqual(["u_a", "u_b", "u_c"])
  })

  test("sort by last seen, newest first", () => {
    expect(usersView([...users].reverse(), { sort: "lastSeen" }).map((u) => u.lastSeen)).toEqual([900, 500, 100])
  })

  test("query matches email or name, case-insensitive", () => {
    expect(usersView(users, { query: "CAR" }).map((u) => u.id)).toEqual(["u_c"])
    expect(usersView(users, { query: "alice" }).map((u) => u.id)).toEqual(["u_a"])
  })

  test("filters: admins, disabled, active", () => {
    expect(usersView(users, { filter: "admins" }).map((u) => u.id)).toEqual(["u_a"])
    expect(usersView(users, { filter: "disabled" }).map((u) => u.id)).toEqual(["u_c"])
    expect(usersView(users, { filter: "active" }).map((u) => u.id)).toEqual(["u_a", "u_b"])
  })
})

describe("userActions", () => {
  const a: AdminUser = { id: "u_a", email: "alice@example.com", role: "admin", created: 1, lastSeen: 1, machines: 0, devices: 0 }
  const b: AdminUser = { id: "u_b", email: "bob@example.com", role: "user", created: 1, lastSeen: 1, machines: 0, devices: 0 }
  const c: AdminUser = { id: "u_c", email: "carol@example.com", role: "user", disabled: true, created: 1, lastSeen: 1, machines: 0, devices: 0 }

  test("a user: make admin and disable, with confirm texts", () => {
    expect(userActions(b, [a, b], "u_a")).toEqual([
      { label: "Make admin", change: { role: "admin" }, confirm: "Make bob@example.com an admin? Admins manage users, machines and the server speech default." },
      { label: "Disable", change: { disabled: true }, danger: true, confirm: "Disable bob@example.com? Their phones and machines are disconnected until you enable them again." },
    ])
  })

  test("a disabled user: enable", () => {
    expect(userActions(c, [a, c], "u_a")[1]).toEqual({ label: "Enable", change: { disabled: false }, confirm: "Enable carol@example.com?" })
  })

  test("yourself: removing your own admin role warns; the last admin is flagged", () => {
    const [role, disable] = userActions(a, [a, b], "u_a")
    expect(role).toEqual({ label: "Remove admin", change: { role: "user" }, danger: true, lastAdmin: true, confirm: "Remove your own admin role? You will lose access to the admin screens." })
    expect(disable!.lastAdmin).toBe(true)
  })
})

describe("adminError", () => {
  test("the server's message wins (e.g. last-admin protection)", () => {
    expect(adminError({ status: 409, message: "Cannot demote the last active admin" })).toBe("Cannot demote the last active admin")
  })

  test("without a message: a generic sentence with the status", () => {
    expect(adminError({ status: 500, message: "" })).toBe("The server refused the change (HTTP 500).")
    expect(adminError({ status: 403, message: "HTTP 403" })).toBe("Only admins can do that.")
  })
})

describe("approveOwner", () => {
  test("names the signed-in email; pairing mode just says you", () => {
    expect(approveOwner(alice)).toBe("This machine will belong to you (alice@example.com).")
    expect(approveOwner(local)).toBe("This machine will belong to you.")
  })
})
