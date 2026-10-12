// Multi-user hub (0.3.0) helpers for the PWA, pure and DOM-free (tested with bun): who is signed in and what the
// account menu shows, the sign-in link, per-user speech settings inherited from the server default, and the admin
// screens' users table, user actions, error messages and audit labels. Contract: docs/multi-user.md.

const str = (v) => (v === undefined || v === null ? "" : String(v).trim())

export const USER_SORTS = Object.freeze([
  ["role", "Admins first"],
  ["email", "Email"],
  ["lastSeen", "Last seen"],
])

export const USER_FILTERS = Object.freeze([
  ["all", "All"],
  ["admins", "Admins"],
  ["active", "Active"],
  ["disabled", "Disabled"],
])

export const AUDIT_ACTIONS = Object.freeze({
  signin: "Signed in",
  "signin.denied": "Sign-in refused",
  "device.pair": "Paired a device",
  "device.revoke": "Revoked a device",
  "machine.approve": "Approved a machine",
  "machine.deny": "Denied a machine",
  "machine.revoke": "Revoked a machine",
  "user.role": "Changed a role",
  "user.disable": "Disabled a user",
  "user.enable": "Enabled a user",
  "speech.default": "Changed the server speech default",
  "migrate.local": "Moved the hub owner's machines and devices to the first admin",
})

// ---------- account ----------

export function isAdmin(me) {
  return me?.user?.role === "admin"
}

/** Header/menu identity: oidc shows name and email; pairing mode (and older hubs) show "This hub". */
export function account(me) {
  const user = me?.user
  const mode = me?.auth === "oidc" ? "oidc" : "pairing"
  const admin = isAdmin(me)
  if (mode !== "oidc") return { mode, admin, title: "This hub", initial: "H" }
  const name = str(user?.name)
  const email = str(user?.email)
  const title = name || email || "Signed in"
  return {
    mode,
    admin,
    title,
    ...(name && email ? { subtitle: email } : {}),
    initial: (title.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(),
    ...(admin ? { badge: "Admin" } : {}),
  }
}

/** The account menu: My devices, Speech, Admin (admins only), Sign out. */
export function menuItems(me) {
  return [
    { id: "devices", label: "My devices" },
    { id: "speech", label: "Speech" },
    ...(isAdmin(me) ? [{ id: "admin", label: "Admin" }] : []),
    { id: "signout", label: "Sign out" },
  ]
}

/** Speech settings tabs: the user's own, plus the server default for admins on a per-user hub. */
export function speechTabs(me, settings) {
  return isAdmin(me) && settings?.scope === "user" ? ["user", "default"] : ["user"]
}

/** Only same-site absolute paths are allowed as a post-sign-in destination. */
function safeNext(next) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/"
}

/** "Sign in with Google" link (GET /api/auth signIn + ?next=); undefined when the hub only pairs. */
export function signInURL(auth, next) {
  if (auth?.mode !== "oidc" || typeof auth.signIn !== "string" || !auth.signIn) return undefined
  return `${auth.signIn}?next=${encodeURIComponent(safeNext(next))}`
}

export function approveOwner(me) {
  const email = me?.auth === "oidc" ? str(me?.user?.email) : ""
  return email ? `This machine will belong to you (${email}).` : "This machine will belong to you."
}

// ---------- speech: own values vs the server default ----------

const SPEECH_FIELDS = { stt: ["provider", "model", "baseURL", "language"], tts: ["provider", "model", "voice", "baseURL", "speed"] }

/**
 * Per field of GET /api/settings/speech (scope "user"): whether the value comes from the server default, with the
 * note to show ("Using server default: <value>", "Key: server default"). Uses the user's own values (`user`) when
 * the hub sends them; otherwise a value equal to the default counts as inherited and a key is the user's own only
 * with source "user". Undefined for responses that are not per-user (older hubs, the default scope).
 */
export function speechInheritance(settings) {
  if (settings?.scope !== "user") return undefined
  const defaults = settings.default ?? {}
  const own = settings.user && typeof settings.user === "object" ? settings.user : undefined
  const out = { own: { stt: 0, tts: 0 } }
  for (const kind of ["stt", "tts"]) {
    const effective = settings[kind] ?? {}
    const fallback = defaults[kind] ?? {}
    const mine = own?.[kind] ?? {}
    const section = {}
    for (const field of SPEECH_FIELDS[kind]) {
      const inherited = own ? mine[field] === undefined || mine[field] === null : str(effective[field]) === str(fallback[field])
      const value = str(fallback[field])
      section[field] = inherited ? { inherited, note: value ? `Using server default: ${value}` : "Server default: not set" } : { inherited }
      if (!inherited) out.own[kind]++
    }
    const ownKey = own ? !!mine.apiKey?.set : effective.apiKey?.source === "user"
    section.apiKey = ownKey ? { inherited: false } : { inherited: true, note: fallback.apiKey?.set === false ? "Key: server default (none set)" : "Key: server default" }
    if (ownKey) out.own[kind]++
    out[kind] = section
  }
  return out
}

/** PUT body that drops every own value of one section (the server default applies again). */
export function resetPatch(kind) {
  return { [kind]: Object.fromEntries([...SPEECH_FIELDS[kind], "apiKey"].map((f) => [f, null])) }
}

// ---------- audit ----------

export function auditLabel(action) {
  const a = str(action)
  if (!a) return "Unknown action"
  if (AUDIT_ACTIONS[a]) return AUDIT_ACTIONS[a]
  const words = a.replace(/[._-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Audit entries newest first, actor and user targets shown by email (or name). */
export function auditRows(entries, users = []) {
  const who = new Map(users.map((u) => [u.id, str(u.email) || str(u.name) || u.id]))
  const person = (id) => (id === "system" ? "System" : who.get(id) ?? id)
  return [...(entries ?? [])]
    .sort((a, b) => b.at - a.at)
    .map((e) => ({
      at: e.at,
      actor: person(e.actor),
      action: auditLabel(e.action),
      target: e.target === undefined ? undefined : who.get(e.target) ?? e.target,
      detail: e.detail,
    }))
}

// ---------- users ----------

const userKey = (u) => (str(u.email) || str(u.name) || u.id).toLowerCase()

/** The admin users table: filtered by text (email/name) and status, sorted. */
export function usersView(users, { query = "", filter = "all", sort = "role" } = {}) {
  const q = str(query).toLowerCase()
  const keep = (u) =>
    (!q || `${str(u.email)} ${str(u.name)}`.toLowerCase().includes(q)) &&
    (filter === "admins" ? u.role === "admin" : filter === "disabled" ? !!u.disabled : filter === "active" ? !u.disabled : true)
  const byKey = (a, b) => userKey(a).localeCompare(userKey(b))
  const compare =
    sort === "lastSeen"
      ? (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || byKey(a, b)
      : sort === "email"
        ? byKey
        : (a, b) => Number(!!a.disabled) - Number(!!b.disabled) || Number(b.role === "admin") - Number(a.role === "admin") || byKey(a, b)
  return (users ?? []).filter(keep).sort(compare)
}

/**
 * Role and enable/disable actions for one user, with confirm texts. `lastAdmin` marks a change the server will
 * refuse (the last active admin); the UI still asks the server and shows its error.
 */
export function userActions(user, users, meID) {
  const label = str(user.email) || str(user.name) || user.id
  const self = user.id === meID
  const activeAdmins = (users ?? []).filter((u) => u.role === "admin" && !u.disabled).length
  const last = user.role === "admin" && !user.disabled && activeAdmins <= 1
  const role =
    user.role === "admin"
      ? {
          label: "Remove admin",
          change: { role: "user" },
          danger: true,
          ...(last ? { lastAdmin: true } : {}),
          confirm: self ? "Remove your own admin role? You will lose access to the admin screens." : `Remove admin from ${label}?`,
        }
      : { label: "Make admin", change: { role: "admin" }, confirm: `Make ${label} an admin? Admins manage users, machines and the server speech default.` }
  const access = user.disabled
    ? { label: "Enable", change: { disabled: false }, confirm: `Enable ${label}?` }
    : {
        label: "Disable",
        change: { disabled: true },
        danger: true,
        ...(last ? { lastAdmin: true } : {}),
        confirm: self
          ? "Disable your own account? This device is signed out."
          : `Disable ${label}? Their phones and machines are disconnected until you enable them again.`,
      }
  return [role, access]
}

/** The message for a failed admin action: the server's own words when it gave any. */
export function adminError(error) {
  const message = str(error?.message)
  if (message && !/^HTTP \d+$/.test(message)) return message
  if (error?.status === 403) return "Only admins can do that."
  return `The server refused the change (HTTP ${error?.status ?? "?"}).`
}
