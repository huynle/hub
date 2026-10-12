// OpenCode Voice PWA. No build step, no dependencies. Routes: / (sessions), /s/:id (talk), /pair, /approve.
// Loaded as an ES module (strict mode, deferred).
import { Conversation } from "./conversation.js"
import { reconcileSay, statusNotes } from "./conversation-core.js"
import {
  ActivityFeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  clampSpeed,
  formatElapsed,
  formatSpeed,
  speechForm,
  speechPatch,
  speechSetup,
  tailText,
  validateSpeech,
  voicesFor,
} from "./feedback-core.js"
import { filterPicker, pickerOptions, stepActive } from "./picker-core.js"
import { applyRate } from "./cues.js"
import { FILTERS, groupOpen, highlight, machineView as browseMachine, page, parseChoices, parseSet, toggleIn } from "./browser-core.js"

const MAX_RECORD_MS = 60_000
const PRESENCE_MS = 30_000
const MAX_FEEDS = 50
const PREF_SPEAK = "voice.speak"
const PREF_SPEED = "voice.speed"
const PREF_CUES = "voice.cues"
const PREF_BACKGROUND = "voice.background"
const PREF_FEED_OPEN = "voice.feedOpen"
const PREF_PINS = "voice.pins" // pinned session IDs (JSON array)
const PREF_PINNED_WS = "voice.pinnedWorkspaces" // pinned workspace/worktree directories (JSON array)
const PREF_GROUPS = "voice.groups" // workspace key → open (JSON object)
const PREF_FILTER = "voice.filter"
const PAGE = 50 // rows per group before "Show more"
const MAX_GROUP_CHOICES = 300

/** Per-device voice preferences (localStorage). */
const prefs = {
  get speed() {
    return clampSpeed(localStorage.getItem(PREF_SPEED))
  },
  get cues() {
    return localStorage.getItem(PREF_CUES) !== "0"
  },
  get background() {
    return localStorage.getItem(PREF_BACKGROUND) === "1"
  },
  get feedOpen() {
    return localStorage.getItem(PREF_FEED_OPEN) !== "0"
  },
}

const $ = (id) => document.getElementById(id)
const view = $("view")
const player = $("player")

const state = {
  me: undefined, // { device, publicURL, version }
  speechReady: undefined, // `ready` from GET /api/settings/speech: { stt, tts, reason? }; null when unknown
  machines: undefined, // catalog from SSE
  enrollments: [],
  source: undefined, // EventSource
  route: undefined, // { name, ...params }
  session: undefined, // per-session view state
  pushed: 0, // in-app history entries (for the back button)
  enrollmentsLoaded: false,
  approved: new Map(), // userCode → result text shown on /approve
  feeds: new Map(), // root session ID → ActivityFeed
  sheetPanel: "main", // "main" | "speech"
  offerConversation: undefined, // session ID just created from the phone: offer conversation mode once
  browser: {
    query: "",
    filter: FILTERS.some(([id]) => id === localStorage.getItem(PREF_FILTER)) ? localStorage.getItem(PREF_FILTER) : "all",
    pins: { sessions: parseSet(localStorage.getItem(PREF_PINS)), workspaces: parseSet(localStorage.getItem(PREF_PINNED_WS)) },
    groups: parseChoices(localStorage.getItem(PREF_GROUPS)),
    limits: new Map(), // group key → rows shown
    exposed: new Map(), // session ID → optimistic exposed value until the catalog agrees
    els: undefined, // persistent search box, chips and list (kept across live updates)
    scroll: 0, // home scroll position when leaving for a session
  },
}

// ---------- small helpers ----------

/** h("div", { class: "x", onclick }, child, "text") — never uses innerHTML for data. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value)
    else if (key === "class") el.className = value
    else if (key === "text") el.textContent = value
    else if (value === true) el.setAttribute(key, "")
    else el.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

function icon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("aria-hidden", "true")
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", d)
    svg.append(path)
  }
  return svg
}
const MIC_ICON = ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"]
const STOP_ICON = ["M7 7h10v10H7z"]
const WAVE_ICON = ["M3 12h2", "M7 8v8", "M11 5v14", "M15 8v8", "M19 11v2"]
const SEARCH_ICON = ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-4-4"]
const PLUS_ICON = ["M12 5v14", "M5 12h14"]
const MORE_ICON = ["M5 12h.01", "M12 12h.01", "M19 12h.01"]

const basename = (dir) => String(dir || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir || ""

function ago(ms) {
  if (!ms) return ""
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

let toastTimer
function toast(message, kind = "", action) {
  const el = $("toast")
  el.replaceChildren(message, action ? h("span", {}, " ", action) : "")
  el.className = `toast show ${kind}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.className = "toast"), action ? 8000 : 4000)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Same-origin fetch with the device cookie. JSON bodies get the JSON content type. */
async function api(path, { method = "GET", json, body, headers = {}, signal, keepalive } = {}) {
  const init = { method, credentials: "same-origin", headers: { ...headers }, signal, keepalive }
  if (json !== undefined) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(json)
  } else if (body !== undefined) init.body = body
  const res = await fetch(path, init)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    if (res.status === 401 && state.route?.name !== "pair") toPair()
    const error = new HttpError(res.status, data.error || `HTTP ${res.status}`)
    if (typeof data.field === "string") error.field = data.field
    if (typeof data.code === "string") error.code = data.code
    throw error
  }
  return res
}
const getJSON = async (path) => (await api(path)).json()

// ---------- routing ----------

function parseRoute(url = new URL(location.href)) {
  const p = url.pathname
  if (p === "/pair") return { name: "pair", next: safeNext(url.searchParams.get("next")) }
  if (p === "/approve") return { name: "approve", code: url.searchParams.get("code") || "" }
  const m = /^\/s\/([^/]+)$/.exec(p)
  if (m) return { name: "session", id: decodeURIComponent(m[1]) }
  return { name: "home" }
}

/** Only same-site absolute paths are allowed as a post-pairing destination. */
function safeNext(next) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/"
}

function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname + location.search) {
    history[replace ? "replaceState" : "pushState"]({ pushed: true }, "", path)
    if (!replace) state.pushed++
  }
  render()
}

function toPair() {
  const here = location.pathname + location.search
  navigate(`/pair${here === "/" || here.startsWith("/pair") ? "" : `?next=${encodeURIComponent(here)}`}`, { replace: true })
}

document.addEventListener("click", (event) => {
  const a = event.target.closest?.("a[data-link]")
  if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
  event.preventDefault()
  navigate(a.getAttribute("href"))
})
window.addEventListener("popstate", () => {
  state.pushed = Math.max(0, state.pushed - 1)
  render()
})

async function render() {
  const route = parseRoute()
  const previous = state.route
  state.route = route
  if (previous?.name === "session" && (route.name !== "session" || route.id !== previous.id)) leaveSession()
  if (previous?.name === "home" && route.name !== "home") state.browser.scroll = window.scrollY

  $("back").hidden = route.name === "home" || route.name === "pair"
  $("heading").textContent = "OpenCode Voice"
  if (route.name === "pair") return renderPair(route)
  if (!(await ensureMe())) return
  $("settings").hidden = false
  startEvents()
  updateNotifyButton()
  if (state.speechReady === undefined) void loadSpeechReady()
  if (location.hash === "#speech") {
    // A one-time sign-in link lands here while speech is not set up yet.
    history.replaceState(history.state, "", location.pathname + location.search)
    openSpeechSettings()
  }
  if (route.name === "approve") return renderApprove(route)
  if (route.name === "session") return renderSession(route)
  return renderHome()
}

async function ensureMe() {
  if (state.me) return true
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" })
    if (res.status === 401) {
      toPair()
      return false
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state.me = await res.json()
    return true
  } catch (error) {
    view.replaceChildren(
      h("div", { class: "empty" }, h("p", {}, `Cannot reach the voice server: ${error.message}`), h("button", { class: "btn", type: "button", onclick: () => render() }, "Retry")),
    )
    return false
  }
}

// ---------- live events ----------

function setConn(kind, text) {
  const el = $("conn")
  el.className = `conn ${kind}`
  el.setAttribute("aria-label", `Server connection: ${text}`)
  $("conn-text").textContent = text
}

function startEvents() {
  if (state.source) return
  setConn("", "connecting")
  const source = new EventSource("/api/events", { withCredentials: true })
  state.source = source
  source.onopen = () => setConn("live", "live")
  source.onerror = async () => {
    setConn("down", "offline")
    // EventSource hides the status code; check whether the device was revoked.
    const res = await fetch("/api/me", { credentials: "same-origin" }).catch(() => undefined)
    if (res?.status === 401) {
      source.close()
      state.source = undefined
      state.me = undefined
      toPair()
    }
  }
  source.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    onEvent(message)
  }
  loadEnrollments()
}

function onEvent(message) {
  switch (message.type) {
    case "catalog":
      state.machines = message.machines
      settleExposed()
      if (state.route?.name === "home") scheduleHomeRender()
      if (state.route?.name === "session") updateSessionHeader()
      if ($("sheet").open) renderSheet()
      break
    case "status":
      applyStatus(message.sessionID, message.sessions)
      state.feeds.get(message.sessionID)?.status(message.sessions)
      if (state.route?.name === "session" && state.session?.id === message.sessionID) {
        onSessionStatus(message.sessions)
        scheduleFeedRender()
      }
      if (state.route?.name === "home") scheduleHomeRender()
      if (state.route?.name === "session") updateSessionHeader()
      break
    case "activity": {
      if (!message.item || typeof message.rootID !== "string") break
      feedFor(message.rootID).activity(message.sessionID, message.item)
      if (state.route?.name === "session" && state.session?.id === message.rootID) scheduleFeedRender()
      if (state.route?.name === "home") scheduleHomeRender()
      break
    }
    case "delta":
    case "reasoning":
      onStream(message)
      break
    case "say":
    case "heard":
    case "conversation":
      if (state.route?.name === "session" && state.session?.id === message.sessionID) onConversationEvent(message)
      if (message.type === "conversation") applyConversation(message.sessionID, message.on)
      break
    case "enrollment":
      loadEnrollments()
      break
    case "handoff": {
      const s = findSession(message.sessionID)
      if (state.route?.name === "session" && state.route.id === message.sessionID) break
      toast(`Handed off: ${s?.title || message.sessionID}`, "", h("a", { href: `/s/${encodeURIComponent(message.sessionID)}`, "data-link": true }, "Open"))
      break
    }
  }
}

/**
 * Streamed text (SSE delta) and reasoning (SSE reasoning) of a root or subagent session: feeds the root's activity
 * feed (Thinking text, subagent output line, "Writing reply"), and the viewed session's reply bubble. Hubs before
 * rootID only streamed root text.
 */
function onStream(message) {
  const reasoning = message.type === "reasoning"
  const text = reasoning ? message.delta : message.text
  if (typeof message.sessionID !== "string" || typeof text !== "string" || !text) return
  const rootID = typeof message.rootID === "string" ? message.rootID : message.sessionID
  const messageID = typeof message.messageID === "string" ? message.messageID : undefined
  const feed = feedFor(rootID)
  const before = feed.pulse().label
  if (reasoning) feed.reasoning(message.sessionID, messageID ?? "unknown", text)
  else feed.text(message.sessionID, messageID, text)
  const route = state.route?.name
  if (route === "session" && state.session) {
    if (!reasoning && state.session.id === message.sessionID) onDelta(text, messageID)
    if (state.session.id === rootID) scheduleFeedRender()
  }
  if (route === "home" && feed.pulse().label !== before) scheduleHomeRender()
}

function applyConversation(sessionID, on) {
  for (const machine of state.machines ?? []) {
    for (const proc of machine.processes) {
      for (const s of proc.sessions) if (s.id === sessionID) s.conversation = on
    }
  }
}

function applyStatus(rootID, sessions) {
  for (const machine of state.machines ?? []) {
    for (const proc of machine.processes) {
      for (const s of proc.sessions) if (s.id === rootID) s.status = sessions
    }
  }
}

/** The activity feed of a root session (created on first use, seeded with the catalog's status tree). */
function feedFor(rootID) {
  let feed = state.feeds.get(rootID)
  if (!feed) {
    feed = new ActivityFeed(rootID)
    const status = findSession(rootID)?.status
    if (status) feed.status(status)
    state.feeds.set(rootID, feed)
    if (state.feeds.size > MAX_FEEDS) state.feeds.delete(state.feeds.keys().next().value)
  }
  return feed
}

let homeFrame
function scheduleHomeRender() {
  if (homeFrame) return
  homeFrame = requestAnimationFrame(() => {
    homeFrame = undefined
    if (state.route?.name === "home") renderHome()
  })
}

async function loadEnrollments() {
  try {
    state.enrollments = (await getJSON("/api/enrollments")).enrollments
  } catch {
    state.enrollments = []
  }
  state.enrollmentsLoaded = true
  const badge = $("settings-badge")
  badge.hidden = state.enrollments.length === 0
  badge.textContent = String(state.enrollments.length)
  $("settings").setAttribute("aria-label", state.enrollments.length ? `Settings, ${state.enrollments.length} machine requests waiting` : "Settings")
  if (state.route?.name === "home") renderHome()
  if (state.route?.name === "approve") renderApprove(state.route)
  if ($("sheet").open) renderSheet()
}

// ---------- session state helpers ----------

/** Overall state of a root session's status tree. */
function overall(status = []) {
  if (status.some((s) => s.state === "blocked")) return "blocked"
  if (status[0]?.state === "error") return "error"
  if (status.some((s) => s.state === "working")) return "working"
  return "idle"
}

function blockersOf(status = []) {
  return status.flatMap((s) => s.blockers.map((b) => ({ ...b, sessionTitle: s.title, sessionID: s.id })))
}

/** First catalog entry for a session (with the process that reports it). */
function findSession(id) {
  for (const machine of state.machines ?? []) {
    for (const proc of machine.processes) {
      const s = proc.sessions.find((x) => x.id === id)
      if (s) return { ...s, machine, process: proc }
    }
  }
  return undefined
}

const STATE_LABEL = { idle: "Idle", working: "Working", blocked: "Needs you", error: "Error" }
const processLabel = (p) => (p.kind === "service" ? "Background service" : `Standalone · ${basename(p.directory)}`)
const enc = encodeURIComponent

// ---------- voice exposure (optimistic) ----------

/** Whether voice is enabled for a session, with a pending Enable/Disable applied. */
function isExposed(id) {
  const pending = state.browser.exposed
  if (pending.has(id)) return pending.get(id)
  return findSession(id)?.exposed !== false
}

/** Drops optimistic values the catalog now agrees with (or whose session is gone). */
function settleExposed() {
  for (const [id, on] of state.browser.exposed) {
    const s = findSession(id)
    if (!s || (s.exposed !== false) === on) state.browser.exposed.delete(id)
  }
}

/** The catalog machine with pending exposure changes applied. */
function withPending(machine) {
  const pending = state.browser.exposed
  if (!pending.size) return machine
  return {
    ...machine,
    processes: machine.processes.map((p) => ({ ...p, sessions: p.sessions.map((s) => (pending.has(s.id) ? { ...s, exposed: pending.get(s.id) } : s)) })),
  }
}

function refreshViews() {
  if (state.route?.name === "home") renderHomeList()
  if (state.route?.name === "session") updateSessionHeader()
}

/** Sessions with an expose request in flight: their view loads nothing until the hub has applied it. */
const exposing = new Set()

/** POST …/expose: shows the result at once and reverts if the hub refuses. */
async function setExposed(id, on, { open = false } = {}) {
  const pending = state.browser.exposed
  pending.set(id, on)
  exposing.add(id)
  refreshViews()
  let ok = false
  try {
    const res = await (await api(`/api/sessions/${enc(id)}/expose`, { method: "POST", json: { on } })).json().catch(() => ({}))
    if (typeof res.exposed === "boolean") pending.set(id, res.exposed)
    ok = true
    toast(on ? "Voice enabled" : "Voice disabled")
  } catch (e) {
    pending.delete(id)
    toast(`Could not ${on ? "enable" : "disable"} voice: ${e.message}`, "err")
  } finally {
    exposing.delete(id)
  }
  settleExposed()
  if (ok && open && on) return navigate(`/s/${enc(id)}`)
  const s = state.session
  if (ok && on && s?.id === id) {
    s.forbidden = false
    loadActivity(s)
    if (document.visibilityState === "visible") postPresence(id, true)
  }
  refreshViews()
}

// ---------- small action sheet ----------

let miniReturn // data-key (or element) to focus when the sheet closes

function miniSheet(title, children, { focus } = {}) {
  const dialog = $("mini")
  const opener = document.activeElement
  miniReturn = opener?.dataset?.key ?? opener
  $("mini-title").textContent = title
  $("mini-body").replaceChildren(...children)
  if (!dialog.open) dialog.showModal()
  ;(focus ?? $("mini-body").querySelector("input, button, a"))?.focus()
}

function closeMini() {
  if ($("mini").open) $("mini").close()
}

$("mini").addEventListener("close", () => {
  const target = typeof miniReturn === "string" ? view.querySelector(`[data-key="${CSS.escape(miniReturn)}"]`) : miniReturn
  miniReturn = undefined
  if (target?.isConnected) target.focus()
})
$("mini-close").addEventListener("click", closeMini)
$("mini").addEventListener("click", (event) => {
  if (event.target === $("mini")) closeMini()
})

// ---------- home (session browser) ----------

function renderHome() {
  $("heading").textContent = "Sessions"
  const b = state.browser
  const fresh = !b.els || !view.contains(b.els.root)
  if (fresh) buildHome()
  b.els.banners.replaceChildren(
    ...[speechBanner()].filter(Boolean),
    ...state.enrollments.map((e) =>
      h("div", { class: "card banner" },
        h("span", {}, h("strong", {}, e.machineName), " wants to connect"),
        h("a", { class: "btn small primary", href: `/approve?code=${enc(e.userCode)}`, "data-link": true }, "Review"))),
  )
  renderHomeList()
  if (fresh) window.scrollTo(0, b.scroll)
}

/** Search box, filter chips and the list container; built once per visit so typing survives live updates. */
function buildHome() {
  const b = state.browser
  const input = h("input", {
    id: "home-search", type: "search", placeholder: "Search sessions, projects, folders", autocomplete: "off",
    autocapitalize: "off", spellcheck: "false", enterkeyhint: "search", "aria-label": "Search sessions", "aria-controls": "home-list",
  })
  input.value = b.query
  let timer
  const apply = () => {
    clearTimeout(timer)
    b.query = input.value
    renderHomeList({ announce: true })
  }
  input.addEventListener("input", () => {
    clearTimeout(timer)
    timer = setTimeout(apply, 120)
  })
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = ""
      apply()
    }
  })
  const search = h("form", { class: "home-search", role: "search", onsubmit: (e) => {
    e.preventDefault()
    apply()
    input.blur()
  } }, icon(SEARCH_ICON), input)
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter sessions" },
    FILTERS.map(([id, label]) => h("button", { type: "button", class: "chip", "data-filter": id, "aria-pressed": String(b.filter === id), onclick: () => setFilter(id) }, label)))
  const count = h("p", { class: "sr-only", role: "status", "aria-live": "polite" })
  const banners = h("div", { class: "stack banners" })
  const list = h("div", { id: "home-list", class: "home-list" })
  const root = h("div", { class: "home" }, banners, h("div", { class: "home-tools" }, search, chips), count, list)
  b.els = { root, input, chips, count, banners, list }
  view.replaceChildren(root)
}

function setFilter(id) {
  const b = state.browser
  b.filter = id
  localStorage.setItem(PREF_FILTER, id)
  for (const chip of b.els.chips.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.dataset.filter === id))
  renderHomeList({ announce: true })
}

const filtering = () => !!state.browser.query.trim() || state.browser.filter !== "all"

/** Re-renders the machine sections, keeping scroll position and keyboard focus (by data-key). */
function renderHomeList({ announce = false } = {}) {
  const b = state.browser
  if (!b.els || state.route?.name !== "home") return
  const { list, count } = b.els
  if (!state.machines) return list.replaceChildren(h("p", { class: "empty" }, "Loading…"))
  if (state.machines.length === 0) {
    return list.replaceChildren(
      h("div", { class: "empty" },
        h("p", {}, "No machines yet."),
        h("p", { class: "small" }, "In OpenCode run /voice → Connect this machine, then approve it here.")),
    )
  }
  const options = { query: b.query, filter: b.filter, pins: b.pins, now: Date.now() }
  const views = state.machines.map((m) => browseMachine(withPending(m), options))
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
  const scroll = window.scrollY
  list.replaceChildren(...views.map(machineSection))
  window.scrollTo(0, scroll)
  if (focused) list.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  if (announce) {
    const shown = views.reduce((n, v) => n + v.shown, 0)
    const total = views.reduce((n, v) => n + v.total, 0)
    count.textContent = filtering() ? `${shown} of ${total} sessions match` : `${total} sessions`
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`
const mark = (text) => highlight(String(text ?? ""), state.browser.query).map((seg) => (seg.hit ? h("mark", {}, seg.text) : seg.text))
const domID = (...parts) => parts.join("-").replace(/[^A-Za-z0-9_-]+/g, "_")

function machineSection(v) {
  const id = domID("m", v.id)
  const summary = v.online
    ? `${plural(v.total, "session")}${filtering() ? ` · ${v.shown} shown` : ""}`
    : `offline · seen ${ago(v.lastSeen)}`
  const parts = [h("div", { class: "machine-head" }, h("h2", { id }, v.name), h("span", { class: "small muted" }, summary))]
  if (v.pinned.length) parts.push(block(v, "pinned", "Pinned", v.pinned))
  if (v.needs.length) parts.push(block(v, "needs", "Needs you", v.needs))
  if (v.active.length) parts.push(block(v, "active", "Active now", v.active))
  if (v.workspaces.length) {
    const hid = domID("ws", v.id)
    parts.push(h("section", { class: "block", "aria-labelledby": hid },
      h("h3", { id: hid, class: "block-title" }, "Workspaces", h("span", { class: "count" }, String(v.workspaces.length))),
      h("div", { class: "groups" }, v.workspaces.map((g) => workspaceGroup(v, g)))))
  } else if (v.online && !v.hasService && !filtering()) {
    parts.push(h("p", { class: "small muted hint" }, "Start the background service (opencode serve --service) on this machine to browse all its sessions by workspace."))
  }
  const procs = v.standalone.filter((p) => p.rows.length || !filtering())
  if (procs.length) {
    const hid = domID("sa", v.id)
    parts.push(h("section", { class: "block", "aria-labelledby": hid },
      h("h3", { id: hid, class: "block-title" }, "Standalone", h("span", { class: "count" }, String(procs.length))),
      procs.map((p) => h("div", { class: "group" },
        h("div", { class: "group-head static" }, h("h4", { class: "group-name" }, basename(p.directory)), h("span", { class: "group-meta" }, `pid ${p.pid}`)),
        p.rows.length ? rowsList(v, `proc:${p.id}`, p.rows, "standalone") : h("p", { class: "small muted hint" }, "No sessions")))))
  }
  if (v.online && filtering() && v.shown === 0) parts.push(h("p", { class: "small muted hint" }, "No sessions match."))
  return h("section", { class: "machine", "aria-labelledby": id }, parts)
}

function block(v, kind, title, rows) {
  const id = domID(kind, v.id)
  return h("section", { class: `block ${kind}`, "aria-labelledby": id },
    h("h3", { id, class: "block-title" }, title, h("span", { class: "count" }, String(rows.length))),
    h("div", { class: "group flat" }, rowsList(v, `${kind}:${v.id}`, rows, kind)))
}

/** Up to `limit` rows of a group, then a "Show more" button. */
function rowsList(v, key, rows, context) {
  if (!rows.length) return null
  const b = state.browser
  const limit = b.limits.get(key) ?? PAGE
  const { rows: shown, more } = page(rows, limit)
  const list = h("ul", { class: "sessions" }, shown.map((r) => sessionRow(v, r, context)))
  if (!more) return list
  return [list, h("button", { class: "btn small more", type: "button", "data-key": `more:${key}`, onclick: () => {
    b.limits.set(key, limit + PAGE)
    renderHomeList()
  } }, `Show ${Math.min(PAGE, more)} more (${more} hidden)`)]
}

function toggleGroup(key, open) {
  const groups = state.browser.groups
  groups.delete(key)
  groups.set(key, !open)
  while (groups.size > MAX_GROUP_CHOICES) groups.delete(groups.keys().next().value)
  localStorage.setItem(PREF_GROUPS, JSON.stringify(Object.fromEntries(groups)))
  renderHomeList()
}

function togglePin(id) {
  const pins = state.browser.pins
  pins.sessions = toggleIn(pins.sessions, id)
  localStorage.setItem(PREF_PINS, JSON.stringify([...pins.sessions]))
  renderHomeList()
}

function togglePinWorkspace(key) {
  const pins = state.browser.pins
  pins.workspaces = toggleIn(pins.workspaces, key)
  localStorage.setItem(PREF_PINNED_WS, JSON.stringify([...pins.workspaces]))
  renderHomeList()
}

/** A workspace (project root) group, or a nested worktree/subfolder group when `parent` is given. */
function workspaceGroup(v, g, parent) {
  const b = state.browser
  const open = groupOpen(g, b.groups, { query: b.query })
  const bodyID = domID("g", v.id, g.key)
  const name = parent ? g.rel || g.dir : g.name
  const fullName = parent ? `${parent.name}/${g.rel || g.dir}` : g.name
  const directory = parent ? g.dir : g.root
  const Heading = parent ? "h5" : "h4"
  const head = h("div", { class: "group-head" },
    h(Heading, { class: "group-name" },
      h("button", { class: "group-toggle", type: "button", "aria-expanded": String(open), "aria-controls": bodyID, "data-key": `toggle:${g.key}`, onclick: () => toggleGroup(g.key, open) },
        h("span", { class: "chev", "aria-hidden": "true" }, "▸"),
        h("span", { class: `dot ${g.state}`, "aria-hidden": "true" }),
        h("span", { class: "group-label" }, mark(name)),
        g.pinned ? h("span", { class: "pin-mark", "aria-hidden": "true" }, "★") : null,
        h("span", { class: "group-meta" }, `${g.count} · ${ago(g.updated)}`),
        h("span", { class: "sr-only" }, `, ${STATE_LABEL[g.state]}${g.pinned ? ", pinned" : ""}`))),
    h("button", { class: "icon-btn small", type: "button", "aria-label": `New session in ${fullName}`, title: "New session here", "data-key": `new:${g.key}`, onclick: () => openNewSession(v, directory, fullName) }, icon(PLUS_ICON)),
    h("button", { class: "icon-btn small", type: "button", "aria-label": `More actions for ${fullName}`, "aria-haspopup": "dialog", "data-key": `menu:${g.key}`, onclick: () => openGroupMenu(v, g, { open, directory, fullName }) }, icon(MORE_ICON)))
  const body = h("div", { id: bodyID, class: "group-body", hidden: !open },
    open ? [rowsList(v, g.key, g.rows, "group"), ...(g.nested ?? []).map((n) => workspaceGroup(v, n, g))] : [])
  return h("div", { class: `group${parent ? " nested" : ""}` }, head, body)
}

function openGroupMenu(v, g, { open, directory, fullName }) {
  const act = (label, fn, cls = "") => h("button", { class: `btn wide ${cls}`, type: "button", onclick: () => {
    closeMini()
    fn()
  } }, label)
  miniSheet(fullName, [
    h("p", { class: "small muted mono" }, directory),
    h("div", { class: "stack" },
      act("New session here", () => openNewSession(v, directory, fullName), "primary"),
      act(g.pinned ? "Unpin workspace" : "Pin workspace", () => togglePinWorkspace(g.key)),
      act(open ? "Collapse" : "Expand", () => toggleGroup(g.key, open))),
  ])
}

function openNewSession(v, directory, name) {
  const title = h("input", { id: "new-title", type: "text", maxlength: "200", autocomplete: "off", placeholder: "Optional", enterkeyhint: "go" })
  const error = h("p", { class: "error small", role: "alert" })
  const submit = h("button", { class: "btn primary", type: "submit" }, "Create session")
  const form = h("form", { class: "stack", novalidate: true },
    h("p", { class: "small muted mono" }, directory),
    h("div", { class: "field" }, h("label", { for: "new-title" }, "Title"), title),
    error,
    h("div", { class: "row" }, submit, h("button", { class: "btn", type: "button", onclick: closeMini }, "Cancel")))
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    submit.disabled = true
    error.textContent = ""
    const json = { directory }
    if (title.value.trim()) json.title = title.value.trim()
    try {
      const { sessionID } = await (await api(`/api/machines/${enc(v.id)}/sessions`, { method: "POST", json })).json()
      miniReturn = undefined
      closeMini()
      state.offerConversation = sessionID
      navigate(`/s/${enc(sessionID)}`)
    } catch (e) {
      error.textContent = e.status === 409
        ? `The background service on ${v.name} isn't connected. Start it, then try again.`
        : `Could not create the session: ${e.message}`
      submit.disabled = false
    }
  })
  miniSheet(`New session in ${name}`, [form], { focus: title })
}

function openEnableSheet(r) {
  miniSheet("Voice is off", [
    h("p", { class: "sheet-lead" }, h("strong", {}, r.title), r.projectName ? ` · ${r.projectName}` : ""),
    h("p", { class: "small muted" },
      "This machine only shares the sessions you switch on. Enable voice to see what this session is doing, talk to it, answer its permission requests and get its notifications."),
    h("div", { class: "row" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        miniReturn = undefined
        closeMini()
        setExposed(r.id, true, { open: true })
      } }, "Enable voice and open"),
      h("button", { class: "btn", type: "button", onclick: closeMini }, "Cancel")),
  ])
}

function sessionRow(v, r, context) {
  const feed = r.state === "working" ? state.feeds.get(r.id) : undefined
  const pulse = feed?.pulse()
  const nowText = r.state === "working" ? (pulse?.busy && pulse.label !== "Working" ? pulse.label : feed?.now() ?? r.nowText ?? "Working") : undefined
  const blocker = r.blockers[0]
  const blockerText = blocker ? `${blocker.kind === "permission" ? "Permission" : "Question"}: ${blocker.summary}` : ""
  const root = r.project || r.directory
  const rel = r.directory && root && r.directory !== root && r.directory.startsWith(`${root}/`) ? r.directory.slice(root.length + 1) : ""
  const where = `${r.projectName || basename(root)}${rel ? ` › ${rel}` : ""}`
  const label = [
    r.title,
    STATE_LABEL[r.state],
    r.conversation ? "voice conversation on" : "",
    r.exposed ? "" : "voice off",
    nowText ? `now: ${nowText}` : "",
    blockerText,
    context === "group" ? "" : where,
    ago(r.updated),
  ].filter(Boolean).join(", ")
  const key = `${context}:${r.id}`
  const content = [
    h("span", { class: `dot ${r.state}`, "aria-hidden": "true" }),
    h("span", { class: "session-title" }, mark(r.title)),
    h("span", { class: "session-when" }, ago(r.updated)),
    nowText || blocker || context !== "group"
      ? h("span", { class: `session-meta${nowText ? " now" : blocker ? " warn" : ""}` },
          nowText ? [h("span", { class: "spinner small", "aria-hidden": "true" }), nowText] : blocker ? `⚠ ${blockerText}` : mark(where))
      : null,
    r.conversation || !r.exposed
      ? h("span", { class: "badges" },
          r.conversation ? h("span", { class: "badge-pill voice" }, icon(MIC_ICON), "voice") : null,
          r.exposed ? null : h("span", { class: "badge-pill off" }, "voice off"))
      : null,
  ]
  const main = r.exposed
    ? h("a", { class: "session-link", href: `/s/${enc(r.id)}`, "data-link": true, "aria-label": label, "data-key": `row:${key}` }, content)
    : h("button", { class: "session-link", type: "button", "aria-haspopup": "dialog", "aria-label": `${label}. Voice is off`, "data-key": `row:${key}`, onclick: () => openEnableSheet(r) }, content)
  return h("li", { class: `session-item${r.exposed ? "" : " unexposed"}` },
    main,
    r.exposed ? null : h("button", { class: "btn small enable", type: "button", "aria-label": `Enable voice for ${r.title}`, "data-key": `enable:${key}`, onclick: () => setExposed(r.id, true) }, "Enable voice"),
    h("div", { class: "row-actions" },
      context === "needs" && r.exposed ? h("a", { class: "btn small primary", href: `/s/${enc(r.id)}`, "data-link": true, "aria-label": `Open ${r.title} to answer` }, "Open") : null,
      h("button", { class: `pin${r.pinned ? " on" : ""}`, type: "button", "aria-pressed": String(r.pinned), "aria-label": `Pin ${r.title}`, "data-key": `pin:${key}`, onclick: () => togglePin(r.id) },
        h("span", { "aria-hidden": "true" }, r.pinned ? "★" : "☆"))))
}

// ---------- pairing ----------

function defaultDeviceName() {
  const ua = navigator.userAgent
  const model = /Pixel[^;)]*/.exec(ua)?.[0] || (/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser")
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ""
  return `${model.trim()}${browser ? ` · ${browser}` : ""}`.slice(0, 64)
}

async function renderPair(route) {
  $("heading").textContent = "Pair this device"
  $("settings").hidden = true
  $("notify").hidden = true
  setConn("", "not paired")
  // Already paired? Go on.
  const me = await fetch("/api/me", { credentials: "same-origin" }).catch(() => undefined)
  if (me?.ok) {
    state.me = await me.json()
    return navigate(route.next, { replace: true })
  }
  const error = h("p", { class: "error", role: "alert" })
  const code = h("input", { id: "pair-code", class: "code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: "6", required: true, "aria-describedby": "pair-help" })
  const name = h("input", { id: "pair-name", type: "text", maxlength: "64", value: defaultDeviceName(), autocomplete: "off" })
  const submit = h("button", { class: "btn primary", type: "submit" }, "Pair")
  const form = h("form", { class: "card stack", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "pair-code" }, "Pairing code"), code),
    h("p", { id: "pair-help", class: "small muted", style: "margin:0" },
      "Open /voice → Pair a phone on a computer connected to this voice server to get a 6-digit code. ",
      "For the very first device, use the code printed in the hub's log."),
    h("div", { class: "field" }, h("label", { for: "pair-name" }, "Device name"), name),
    error,
    submit,
  )
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    error.textContent = ""
    const value = code.value.replace(/\D/g, "")
    if (value.length !== 6) {
      error.textContent = "Enter the 6-digit code."
      return code.focus()
    }
    submit.disabled = true
    try {
      await api("/api/pair", { method: "POST", json: { code: value, deviceName: name.value.trim() || defaultDeviceName() } })
      state.me = undefined
      navigate(route.next, { replace: true })
    } catch (e) {
      error.textContent = e.status === 401 ? "That code is wrong or expired. Get a fresh one and try again." : e.message
      submit.disabled = false
      code.select()
    }
  })
  view.replaceChildren(h("div", { class: "stack" },
    h("p", { class: "muted" }, "Pair this browser with your voice server to see and talk to your OpenCode sessions."),
    h("p", { class: "small muted" }, "On the computer itself, /voice → Open voice UI signs this browser in without a code."),
    form))
  code.focus()
}

// ---------- machine approval ----------

function renderApprove(route) {
  $("heading").textContent = "Approve machine"
  const code = route.code.toUpperCase()
  const pending = state.enrollments.find((e) => e.userCode === code)
  const result = h("p", { role: "status" })
  const done = state.approved.get(code)
  if (done) {
    view.replaceChildren(h("div", { class: "card stack" }, h("p", { role: "status" }, done), h("a", { class: "btn", href: "/", "data-link": true }, "Back to sessions")))
    return
  }
  if (!pending && !state.enrollmentsLoaded) {
    view.replaceChildren(h("p", { class: "empty" }, "Loading…"))
    return
  }
  if (!pending) {
    view.replaceChildren(
      h("div", { class: "card stack" },
        h("p", {}, code ? `No pending request with code ${code}. It may have expired or been answered already.` : "No code given."),
        h("a", { class: "btn", href: "/", "data-link": true }, "Back to sessions")),
    )
    return
  }
  const decide = async (action) => {
    for (const b of view.querySelectorAll("button")) b.disabled = true
    try {
      await api(`/api/enrollments/${encodeURIComponent(code)}/${action}`, { method: "POST", json: {} })
      state.approved.set(code, action === "approve" ? `${pending.machineName} is approved. It will connect in a few seconds.` : `Denied ${pending.machineName}.`)
      if (state.route?.name === "approve") renderApprove(state.route)
    } catch (e) {
      result.textContent = e.message
      for (const b of view.querySelectorAll("button")) b.disabled = false
    }
  }
  view.replaceChildren(
    h("div", { class: "card stack" },
      h("p", {}, h("strong", {}, pending.machineName), " wants to connect to this voice server."),
      h("p", { class: "small muted" }, `Code ${pending.userCode} · requested ${ago(pending.created)}. Approve only if this code matches the one shown in OpenCode.`),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => decide("approve") }, "Approve"),
        h("button", { class: "btn danger", type: "button", onclick: () => decide("deny") }, "Deny")),
      result),
  )
}

// ---------- session view ----------

function leaveSession() {
  const s = state.session
  if (!s) return
  if (s.recorder?.state === "recording") {
    s.discard = true
    s.recorder.stop()
  }
  s.conversation?.stop({ keepalive: true })
  player.pause()
  clearInterval(s.presenceTimer)
  clearInterval(s.pulseTimer)
  postPresence(s.id, false)
  state.session = undefined
}

// ---------- presence ----------

/** Tells the hub whether this session is on screen (it pushes replies when nobody watches). */
function postPresence(id, visible, { keepalive = false } = {}) {
  api(`/api/sessions/${encodeURIComponent(id)}/presence`, { method: "POST", json: { visible }, keepalive }).catch(() => {})
}

function startPresence(s) {
  const beat = () => state.session === s && !s.gated && document.visibilityState === "visible" && postPresence(s.id, true)
  beat()
  s.presenceTimer = setInterval(beat, PRESENCE_MS)
}

document.addEventListener("visibilitychange", () => {
  const s = state.session
  if (!s) return
  const visible = document.visibilityState === "visible"
  postPresence(s.id, visible, { keepalive: !visible })
  if (visible) scheduleFeedRender()
})

// ---------- voice speed ----------

function setSpeed(value) {
  const rate = clampSpeed(value)
  localStorage.setItem(PREF_SPEED, String(rate))
  applyRate(player, rate)
  for (const input of document.querySelectorAll("input[data-speed]")) {
    if (Number(input.value) !== rate) input.value = String(rate)
    input.setAttribute("aria-valuetext", formatSpeed(rate))
    const out = document.querySelector(`output[for="${input.id}"]`)
    if (out) out.textContent = formatSpeed(rate)
  }
}

/** Range input for the voice speed (0.75×–2.0×), synced with every other speed control on the page. */
function speedControl(id, label) {
  const rate = prefs.speed
  const input = h("input", { id, type: "range", min: SPEED_MIN, max: SPEED_MAX, step: SPEED_STEP, value: rate, "data-speed": true, "aria-valuetext": formatSpeed(rate) })
  input.addEventListener("input", () => setSpeed(input.value))
  return h("div", { class: "speed" }, h("label", { for: id }, label), input, h("output", { for: id, class: "speed-value" }, formatSpeed(rate)))
}

// ---------- activity feed ----------

const FEED_MARK = { running: "▶", done: "✓", failed: "✗" }
const FEED_STATE = { running: "running", done: "done", failed: "failed" }
const SUBAGENT_WORD = { working: "working", blocked: "needs you", done: "done", failed: "failed" }

function feedRow(r) {
  const indent = r.depth ? " nested" : ""
  if (r.kind === "subagent") {
    return h("li", { class: `feed-row sub ${r.state}${indent}` },
      h("span", { class: "feed-mark", "aria-hidden": "true" }, r.state === "working" ? "◆" : r.state === "failed" ? "✗" : r.state === "done" ? "✓" : "!"),
      h("span", { class: "feed-label" }, `Subagent: ${r.label}`, h("span", { class: "feed-state" }, ` — ${SUBAGENT_WORD[r.state] ?? r.state}`)),
      r.line ? h("span", { class: "feed-line", title: r.line }, r.line) : null)
  }
  if (r.kind === "thinking") {
    const mark = h("span", { class: "feed-mark", "aria-hidden": "true" }, r.state === "running" ? "…" : "✓")
    if (!r.text) return h("li", { class: `feed-row thinking ${r.state}${indent}` }, mark, h("span", { class: "feed-label" }, r.label))
    // Streamed reasoning: the last lines while collapsed (newest at the bottom), all of it when expanded.
    const open = !!state.session?.expanded.has(r.key)
    const bodyID = domID("thought", r.key)
    const body = h("div", { id: bodyID, class: `thought-text${open ? " open" : ""}` }, open ? r.text : tailText(r.text, 4))
    return h("li", { class: `feed-row thinking ${r.state}${indent}` },
      h("button", { class: "thought-toggle", type: "button", "aria-expanded": String(open), "aria-controls": bodyID, "data-key": `thought:${r.key}`, onclick: () => toggleThought(r.key) },
        mark, h("span", { class: "feed-label" }, r.label), h("span", { class: "thought-more", "aria-hidden": "true" }, open ? "Less" : "More")),
      body)
  }
  return h("li", { class: `feed-row tool ${r.state}${indent}` },
    h("span", { class: "feed-mark", role: "img", "aria-label": FEED_STATE[r.state] ?? r.state }, FEED_MARK[r.state] ?? "•"),
    h("span", { class: "feed-label" }, r.label, r.error ? h("span", { class: "feed-error" }, ` — ${r.error}`) : null))
}

let feedFrame
function scheduleFeedRender() {
  if (feedFrame) return
  feedFrame = requestAnimationFrame(() => {
    feedFrame = undefined
    renderFeed()
  })
}

function toggleThought(key) {
  const s = state.session
  if (!s) return
  if (!s.expanded.delete(key)) s.expanded.add(key)
  renderFeed()
}

function renderFeed() {
  const s = state.session
  if (!s) return
  const feed = state.feeds.get(s.id)
  const rows = feed?.rows() ?? []
  const { feedBox, feedList } = s.els
  feedBox.hidden = rows.length === 0 || s.gated
  const list = feedList
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
  list.replaceChildren(...rows.map(feedRow))
  if (atEnd) list.scrollTop = list.scrollHeight
  for (const open of list.querySelectorAll(".thought-text.open")) open.scrollTop = open.scrollHeight
  if (focused) list.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  renderPulse()
}

/**
 * The "now" header: spinner, "Working… 12s" and what the session does while the root or a subagent works,
 * "Needs you" while blocked, else "Idle · last activity 2m ago". Screen readers hear only label changes.
 */
function renderPulse() {
  const s = state.session
  if (!s) return
  const { pulse, pulseIcon, pulseHead, pulseWhat, pulseSr } = s.els
  const info = findSession(s.id)
  pulse.hidden = s.gated || !info
  if (pulse.hidden) return
  const p = feedFor(s.id).pulse()
  const mode = p.busy ? "busy" : p.blocked ? "blocked" : "idle"
  if (pulse.dataset.mode !== mode) {
    pulse.dataset.mode = mode
    pulse.className = `pulse ${mode}`
    pulseIcon.replaceChildren(p.busy ? h("span", { class: "spinner" }) : h("span", { class: `dot ${p.blocked ? "blocked" : "idle"}` }))
  }
  const lastAt = Math.max(p.lastAt ?? 0, info.updated ?? 0)
  let head = p.label
  let what = ""
  if (p.busy) {
    head = `Working…${p.since ? ` ${formatElapsed(Date.now() - p.since)}` : ""}`
    what = p.label === "Working" ? "" : p.label
  } else if (!p.blocked) {
    head = lastAt ? `Idle · last activity ${ago(lastAt)}` : "Idle"
  } else {
    what = "Answer the request below"
  }
  if (pulseHead.textContent !== head) pulseHead.textContent = head
  if (pulseWhat.textContent !== what) pulseWhat.textContent = what
  const spoken = p.busy ? `Working: ${what || "busy"}` : p.blocked ? "Needs you" : "Idle"
  if (pulseSr.textContent !== spoken) pulseSr.textContent = spoken
}

function toggleFeed() {
  const s = state.session
  if (!s) return
  const open = s.els.feedToggle.getAttribute("aria-expanded") !== "true"
  localStorage.setItem(PREF_FEED_OPEN, open ? "1" : "0")
  s.els.feedToggle.setAttribute("aria-expanded", String(open))
  s.els.feedList.hidden = !open
  if (open) s.els.feedList.scrollTop = s.els.feedList.scrollHeight
}

/** GET /api/sessions/:id for the activity backlog (older hubs answer without it). */
async function loadActivity(s) {
  try {
    const info = await getJSON(`/api/sessions/${encodeURIComponent(s.id)}`)
    if (state.session !== s) return
    const feed = feedFor(s.id)
    feed.load(info.activity ?? [])
    if (info.status) feed.status(info.status)
    renderFeed()
  } catch {
    // no backlog: the feed fills from live events
  }
}

function renderSession(route) {
  const s = (state.session = {
    id: route.id,
    busy: false,
    live: undefined,
    loaded: false,
    loading: false,
    recorder: undefined,
    conversation: undefined, // Conversation while hands-free mode is on
    lastAgent: undefined, // last finished agent bubble since the last user message (for "say" dedupe)
    status: findSession(route.id)?.status, // previous status tree, for subagent notes
    liveID: undefined, // assistant message ID streaming into `live`
    bubbles: new Map(), // assistant message ID → its bubble (for "say" dedupe)
    expanded: new Set(), // expanded Thinking rows (feed row keys)
    forbidden: false, // the hub answered 403 not_exposed
    gated: false, // the "Enable voice" call-to-action is showing
    els: {},
  })
  const els = s.els
  els.state = h("div", { class: "session-state", role: "status", "aria-live": "polite" })
  els.blockers = h("div", { class: "blockers", "aria-live": "polite" })
  els.transcript = h("div", { class: "transcript", "aria-live": "polite", "aria-label": "Conversation" })
  els.mic = h("button", { class: "mic", type: "button", "aria-label": "Start recording", onclick: onMic }, icon(MIC_ICON))
  els.micLabel = h("div", { class: "mic-label", "aria-live": "polite" }, "Tap to talk")
  els.convo = h("button", { class: "convo", type: "button", "aria-pressed": "false", "aria-label": "Conversation mode", onclick: onConversationToggle },
    icon(WAVE_ICON), h("span", {}, "Conversation"))
  els.held = h("div", { class: "held", "aria-live": "polite" })
  els.input = h("input", { type: "text", placeholder: "…or type a message", autocomplete: "off", "aria-label": "Message", enterkeyhint: "send" })
  els.send = h("button", { class: "btn", type: "submit" }, "Send")
  const typed = h("form", { class: "typed" }, els.input, els.send)
  typed.addEventListener("submit", (event) => {
    event.preventDefault()
    const text = els.input.value.trim()
    if (!text) return
    if (s.conversation) {
      els.input.value = ""
      s.conversation.sendTyped(text)
      return
    }
    if (s.busy) return
    els.input.value = ""
    unlockAudio()
    runTurn(text)
  })
  els.speak = h("input", { id: "speak", type: "checkbox" })
  els.speak.checked = localStorage.getItem(PREF_SPEAK) !== "0"
  els.speak.addEventListener("change", () => localStorage.setItem(PREF_SPEAK, els.speak.checked ? "1" : "0"))
  const feedOpen = prefs.feedOpen
  els.feedToggle = h("button", { class: "feed-toggle", type: "button", "aria-expanded": String(feedOpen), "aria-controls": "activity-list", onclick: toggleFeed },
    h("span", { class: "feed-chevron", "aria-hidden": "true" }, "▸"), "Activity")
  els.feedList = h("ol", { id: "activity-list", class: "feed-list", hidden: !feedOpen, "aria-label": "Activity steps", tabindex: "0" })
  els.feedBox = h("section", { class: "feed", "aria-label": "Live activity", hidden: true },
    h("div", { class: "feed-head" }, els.feedToggle), els.feedList)
  els.pulseIcon = h("span", { class: "pulse-icon", "aria-hidden": "true" })
  els.pulseHead = h("span", { class: "pulse-head", "aria-hidden": "true" })
  els.pulseWhat = h("span", { class: "pulse-what", "aria-hidden": "true" })
  els.pulseSr = h("span", { class: "sr-only", role: "status", "aria-live": "polite" })
  els.pulse = h("div", { class: "pulse idle", hidden: true }, els.pulseIcon, els.pulseHead, els.pulseWhat, els.pulseSr)

  els.gate = h("section", { class: "gate card", "aria-labelledby": "gate-title", hidden: true })
  els.speechSetup = h("div", { class: "speech-setup-slot" })
  els.composer = h("div", { class: "composer" })
  view.replaceChildren(
    h("div", { class: "session-view" },
      els.pulse,
      els.state,
      els.gate,
      els.feedBox,
      els.blockers,
      els.transcript,
      els.speechSetup,
      els.composer))
  els.composer.append(
    els.held,
    h("div", { class: "mic-row" }, h("span", { class: "mic-side", "aria-hidden": "true" }), els.mic, h("span", { class: "mic-side" }, els.convo)),
    els.micLabel,
    typed,
    h("div", { class: "voice-row" },
      h("label", { class: "toggle", for: "speak" }, els.speak, "Read replies aloud"),
      speedControl("speed-session", "Speed")))
  if (state.offerConversation === route.id) {
    state.offerConversation = undefined
    const offer = h("div", { class: "offer card" },
      h("p", {}, "New session created. Talk to it hands-free?"),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => {
          offer.remove()
          onConversationToggle()
        } }, icon(WAVE_ICON), "Start conversation mode"),
        h("button", { class: "btn", type: "button", onclick: () => offer.remove() }, "Not now")))
    els.transcript.append(offer)
  }
  updateSessionHeader()
  applySpeechGate(s)
  loadTranscript()
  renderFeed()
  loadActivity(s)
  startPresence(s)
  s.pulseTimer = setInterval(() => state.session === s && document.visibilityState === "visible" && renderPulse(), 1000)
}

function updateSessionHeader() {
  const s = state.session
  if (!s) return
  const info = findSession(s.id)
  $("heading").textContent = info?.title || (state.machines ? "Unknown session" : "Loading…")
  updateConversationHint(s)
  if (!info) {
    s.els.state.replaceChildren(
      state.machines ? h("span", { class: "error" }, "No connected OpenCode process reports this session.") : "Loading…",
    )
    s.els.blockers.replaceChildren()
    return
  }
  const st = overall(info.status)
  if (!gate(s, info)) return
  s.els.state.replaceChildren(
    h("span", { class: `dot ${st}`, "aria-hidden": "true" }),
    h("span", { title: `${processLabel(info.process)} · pid ${info.process.pid}` }, `${STATE_LABEL[st]} · ${basename(info.directory)} · ${info.machine.name}`),
  )
  if (st !== "working" && !s.busy && s.live) finishLive()
  renderBlockers(info)
  renderPulse()
  if (!s.loaded && !s.loading) loadTranscript()
}

/**
 * Shows the "Enable voice" call-to-action instead of the conversation while voice is off for the session
 * (catalog exposed:false, or the hub answered 403 not_exposed). Returns whether the session is usable.
 */
function gate(s, info) {
  const exposed = !s.forbidden && isExposed(s.id)
  const { gate: box, composer, transcript, feedBox, blockers } = s.els
  composer.hidden = transcript.hidden = !exposed
  box.hidden = exposed
  if (exposed) {
    if (s.gated) {
      s.gated = false
      if (!exposing.has(s.id)) loadActivity(s)
    }
    return true
  }
  s.gated = true
  feedBox.hidden = true
  blockers.replaceChildren()
  s.els.state.replaceChildren(h("span", { class: "dot idle", "aria-hidden": "true" }), h("span", {}, `Voice off · ${basename(info?.directory)} · ${info?.machine?.name ?? ""}`))
  if (!box.firstChild) {
    box.append(
      h("h2", { id: "gate-title" }, "Voice is off for this session"),
      h("p", { class: "small muted" },
        "This machine only shares the sessions you switch on. Enable voice to see what it's doing, talk to it, answer its permission requests and get its notifications."),
      h("button", { class: "btn primary", type: "button", onclick: () => setExposed(s.id, true) }, "Enable voice for this session"))
  }
  return false
}

function renderBlockers(info) {
  const s = state.session
  const blockers = blockersOf(info.status)
  s.els.blockers.replaceChildren(
    ...blockers.map((b) => {
      const who = b.sessionID === info.id ? "" : ` (${b.sessionTitle})`
      if (b.kind !== "permission") {
        return h("div", { class: "blocker" },
          h("p", {}, h("strong", {}, `Question${who}: `), b.summary),
          h("p", { class: "small muted", style: "margin:0" }, "Answer this one in the terminal."))
      }
      const box = h("div", { class: "blocker", role: "group", "aria-label": `Permission request: ${b.summary}` },
        h("p", {}, h("strong", {}, `Permission${who}: `), b.summary))
      const row = h("div", { class: "row" })
      for (const [decision, label, cls] of [["once", "Allow once", "primary"], ["always", "Always", ""], ["reject", "Deny", "danger"]]) {
        row.append(h("button", { class: `btn small ${cls}`, type: "button", onclick: (e) => answerPermission(b, decision, e.currentTarget) }, label))
      }
      box.append(row)
      return box
    }),
  )
}

async function answerPermission(blocker, decision, button) {
  const s = state.session
  if (!s) return
  for (const b of button.parentElement.querySelectorAll("button")) b.disabled = true
  try {
    await api(`/api/sessions/${encodeURIComponent(s.id)}/permission`, { method: "POST", json: { requestID: blocker.id, decision } })
    toast(decision === "reject" ? "Denied" : "Allowed")
  } catch (e) {
    toast(e.message, "err")
    for (const b of button.parentElement.querySelectorAll("button")) b.disabled = false
  }
}

async function loadTranscript() {
  const s = state.session
  if (!s || s.loading || s.loaded || s.gated || exposing.has(s.id) || !findSession(s.id)) return
  s.loading = true
  try {
    const { messages } = await getJSON(`/api/sessions/${encodeURIComponent(s.id)}/context`)
    if (state.session !== s) return
    s.loaded = true
    const nodes = messages.map((m) => h("div", { class: `msg ${m.role === "user" ? "user" : "assistant"}` }, m.text))
    if (!nodes.length) nodes.push(h("div", { class: "note" }, "No messages yet. Tap the mic to start."))
    s.els.transcript.prepend(...nodes)
    scrollToEnd()
  } catch (e) {
    if (state.session !== s) return
    if (e.status === 403 && e.code === "not_exposed") {
      s.forbidden = true
      s.loading = false
      return updateSessionHeader()
    }
    note(e.status === 409 ? e.message : `Could not load the conversation: ${e.message}`, "err")
  } finally {
    s.loading = false
  }
}

function add(role, text) {
  const s = state.session
  if (!s) return
  const el = h("div", { class: `msg ${role}` }, text)
  s.els.transcript.append(el)
  if (role === "user") s.lastAgent = undefined
  else s.lastAgent = el
  scrollToEnd()
  return el
}

function note(text, kind = "") {
  const s = state.session
  if (!s) return
  s.els.transcript.append(h("div", { class: `note ${kind}`, role: kind === "err" ? "alert" : undefined }, text))
  scrollToEnd()
}

function scrollToEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }))
}

/** Streams reply text of the viewed session into its bubble: one bubble per assistant message. */
function onDelta(text, messageID) {
  const s = state.session
  if (s.live && messageID && s.liveID && s.liveID !== messageID) finishLive()
  if (!s.live) {
    s.live = add("assistant", "")
    s.live.classList.add("live")
    s.live.setAttribute("aria-busy", "true")
    s.liveID = messageID
    if (messageID) {
      s.bubbles.set(messageID, s.live)
      if (s.bubbles.size > 50) s.bubbles.delete(s.bubbles.keys().next().value)
    }
  }
  s.live.textContent += text
  scrollToEnd()
}

function finishLive(finalText) {
  const s = state.session
  if (!s) return
  if (finalText !== undefined) {
    if (s.live) s.live.textContent = finalText
    else add("assistant", finalText)
  }
  if (s.live) {
    s.live.classList.remove("live")
    s.live.removeAttribute("aria-busy")
    s.lastAgent = s.live
  }
  s.live = undefined
  s.liveID = undefined
}

function setBusy(busy, label) {
  const s = state.session
  if (!s || s.conversation) return
  s.busy = busy
  s.els.mic.disabled = busy
  s.els.send.disabled = busy
  s.els.micLabel.textContent = label ?? "Tap to talk"
}

function turnError(e) {
  if (e.status === 409) return e.message // busy, or no process connected
  if (e.status === 504) return "OpenCode did not answer in time. The session may still be working; check back in a moment."
  if (e.status === 502) return `OpenCode reported a problem: ${e.message}`
  if (e.status === 429) return "Too many requests; wait a moment."
  return e.message
}

async function runTurn(text) {
  const s = state.session
  if (!s) return
  add("user", text)
  setBusy(true, "Thinking…")
  finishLive()
  try {
    const result = await (await api(`/api/sessions/${encodeURIComponent(s.id)}/turn`, { method: "POST", json: { text } })).json()
    if (state.session !== s) return
    const reply = result.reply || ""
    finishLive(reply || "(no text reply)")
    if (result.outcome === "timeout") note("The agent is still working; the reply above may be partial.")
    else if (result.outcome !== "succeeded") note(`Turn ${result.outcome}${result.message ? `: ${result.message}` : ""}`, "err")
    if (s.els.speak.checked && reply) await speak(reply, s)
  } catch (e) {
    if (state.session === s) {
      finishLive()
      note(turnError(e), "err")
    }
  } finally {
    if (state.session === s) setBusy(false)
  }
}

async function speak(text, s) {
  setBusy(true, "Speaking…")
  let url
  try {
    const audio = await (await api("/api/speak", { method: "POST", json: { text } })).blob()
    if (state.session !== s) return
    url = URL.createObjectURL(audio)
    player.src = url
    const played = await player.play().then(() => true, () => false)
    if (!played) {
      note("The browser blocked audio playback. Tap the mic or Send again to allow it.")
      return
    }
    s.els.micLabel.textContent = "Speaking… tap the mic to stop"
    s.els.mic.disabled = false
    await new Promise((resolve) => {
      const done = () => resolve()
      player.onended = player.onpause = player.onerror = done
    })
  } catch (e) {
    if (state.session === s) note(`Could not read the reply aloud: ${e.message}`, "err")
  } finally {
    player.onended = player.onpause = player.onerror = null
    if (url) URL.revokeObjectURL(url)
  }
}

// Browsers (iOS especially) only allow playback started from a user gesture; prime the player during the tap
// so the reply can play after the async turn finishes.
function unlockAudio() {
  if (!player.paused) return
  player.muted = true
  player.play().catch(() => {}).finally(() => {
    player.pause()
    player.muted = false
  })
}

// ---------- conversation mode (hands-free) ----------

const CONVO_LABEL = {
  starting: "Starting…",
  listening: "Listening…",
  hearing: "Hearing you…",
  transcribing: "Transcribing…",
  sent: "Sent ✓",
  speaking: "Speaking… talk or tap to interrupt",
  paused: "Paused — tap the mic to listen again",
}
const TICKS = { sent: ["✓", "Sent"], heard: ["✓✓", "Heard by the agent"], failed: ["!", "Not sent"] }

async function onConversationToggle() {
  const s = state.session
  if (!s) return
  if (s.conversation) return s.conversation.stop()
  if (s.recorder?.state === "recording" || s.busy) return toast("Finish the current turn first.")
  unlockAudio()
  const convo = new Conversation({
    sessionID: s.id,
    api,
    player,
    ui: conversationUI(s),
    options: {
      cues: prefs.cues,
      background: prefs.background,
      speed: () => prefs.speed,
      title: () => findSession(s.id)?.title || "OpenCode session",
      status: findSession(s.id)?.status,
    },
  })
  s.conversation = convo
  setConversationUI(s, true)
  const started = await convo.start()
  if (state.session !== s) return started && convo.stop({ keepalive: true }) // left while starting
  if (!started) {
    if (s.conversation === convo) s.conversation = undefined
    return setConversationUI(s, false)
  }
  note(`Conversation mode on${convo.agent ? ` (${convo.agent} agent)` : ""}. Speak naturally; say “stop” to interrupt, “pause listening” to end.`, "sys")
}

function setConversationUI(s, on) {
  const { convo, mic, micLabel } = s.els
  convo.setAttribute("aria-pressed", String(on))
  convo.classList.toggle("on", on)
  mic.classList.toggle("listening", on)
  mic.disabled = false
  mic.setAttribute("aria-label", on ? "Stop reading aloud" : "Start recording")
  if (!on) {
    mic.style.removeProperty("--level")
    micLabel.textContent = "Tap to talk"
  }
  updateConversationHint(s)
}

/** View callbacks for a Conversation; inert once the user left this session view. */
function conversationUI(s) {
  const live = () => state.session === s
  return {
    state: (name) => {
      if (!live() || name === "off") return
      s.els.micLabel.textContent = CONVO_LABEL[name] ?? ""
      s.els.mic.dataset.state = name
      s.els.mic.setAttribute("aria-label", name === "paused" ? "Resume listening" : "Stop reading aloud")
    },
    level: (x) => live() && s.els.mic.style.setProperty("--level", x.toFixed(2)),
    held: (text) => live() && (s.els.held.textContent = text ? `${text} …` : ""),
    user: (text) => {
      if (!live()) return h("div")
      finishLive()
      const el = add("user", text)
      el.append(h("span", { class: "tick pending", "aria-label": "Sending" }, "…"))
      return el
    },
    tick: (el, kind) => {
      const tick = el.querySelector?.(".tick")
      if (!tick) return
      const [mark, label] = TICKS[kind]
      tick.textContent = mark
      tick.className = `tick ${kind}`
      tick.setAttribute("aria-label", label)
    },
    agent: (message) => live() && showSay(s, message),
    note: (text, kind) => live() && note(text, kind),
    ended: () => {
      if (!live()) return
      s.conversation = undefined
      setConversationUI(s, false)
    },
  }
}

/**
 * Shows spoken agent text, deduped against the bubble streamed from deltas: the bubble of the same assistant
 * message when there is one, else the streaming or last agent bubble. Text of another message than the one
 * streaming goes in its own bubble before the streaming one.
 */
function showSay(s, message) {
  const own = typeof message.messageID === "string" ? s.bubbles.get(message.messageID) : undefined
  const bubble = own?.isConnected ? own : s.live ?? s.lastAgent
  const { mode, text } = reconcileSay(bubble?.textContent ?? "", message.text)
  if (mode === "update") bubble.textContent = text
  else if (mode === "new") {
    if (s.live && s.liveID && message.messageID && s.liveID !== message.messageID) {
      s.live.before(h("div", { class: "msg assistant" }, text))
    } else {
      finishLive()
      const el = add("assistant", text)
      if (typeof message.messageID === "string") s.bubbles.set(message.messageID, el)
    }
  }
  scrollToEnd()
}

function onConversationEvent(message) {
  const s = state.session
  if (!s) return
  s.conversation?.onEvent(message)
  if (message.type === "conversation") updateConversationHint(s)
}

/** Conversation mode switched on elsewhere (TUI or another phone) while this page is not listening. */
function updateConversationHint(s) {
  const remote = !s.conversation && !!findSession(s.id)?.conversation
  s.els.convo.classList.toggle("remote", remote)
  s.els.convo.title = remote ? "Conversation mode is on in OpenCode; tap to listen on this phone" : ""
}

function onSessionStatus(sessions) {
  const s = state.session
  if (!s) return
  for (const text of statusNotes(s.status, sessions, s.id)) note(text, "sys")
  s.status = sessions
  s.conversation?.onStatus(sessions)
}

window.addEventListener("pagehide", () => {
  const s = state.session
  if (!s) return
  s.conversation?.stop({ keepalive: true })
  postPresence(s.id, false, { keepalive: true })
})

function pickType() {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type
  }
  return ""
}

async function onMic() {
  const s = state.session
  if (!s) return
  if (s.conversation) return s.conversation.hush() // hands-free: the mic only stops reading aloud
  if (s.recorder?.state === "recording") return s.recorder.stop()
  if (!player.paused) return player.pause() // stop reading aloud
  if (s.busy) return
  if (speechSetup(state.speechReady ?? undefined, state.me?.publicURL)?.micBlocked) return openSpeechSettings()
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    note("This browser cannot record here (the microphone needs HTTPS). Use the typed input instead.", "err")
    return
  }
  unlockAudio()
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    note(e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings." : `Microphone: ${e.message}`, "err")
    return
  }
  if (state.session !== s) return stream.getTracks().forEach((t) => t.stop())
  const mimeType = pickType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks = []
  let stopTimer, tick
  const started = Date.now()
  s.recorder = recorder
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder.onstop = async () => {
    clearTimeout(stopTimer)
    clearInterval(tick)
    stream.getTracks().forEach((t) => t.stop())
    s.recorder = undefined
    s.els.mic.classList.remove("recording")
    s.els.mic.setAttribute("aria-label", "Start recording")
    s.els.mic.replaceChildren(icon(MIC_ICON))
    if (s.discard || state.session !== s) return
    const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || "audio/webm").split(";")[0] })
    if (blob.size === 0) return setBusy(false)
    setBusy(true, "Transcribing…")
    try {
      const { text } = await (await api("/api/transcribe", { method: "POST", body: blob, headers: { "content-type": blob.type } })).json()
      if (state.session !== s) return
      if (!text?.trim()) {
        note("Didn't catch that. Try again.")
        return setBusy(false)
      }
      await runTurn(text.trim())
    } catch (e) {
      if (state.session === s) {
        note(e.status === 413 ? "That recording was too long." : `Transcription failed: ${e.message}`, "err")
        setBusy(false)
      }
    }
  }
  recorder.start()
  s.els.mic.classList.add("recording")
  s.els.mic.setAttribute("aria-label", "Stop recording and send")
  s.els.mic.replaceChildren(icon(STOP_ICON))
  const label = () => {
    const left = Math.max(0, Math.ceil((MAX_RECORD_MS - (Date.now() - started)) / 1000))
    s.els.micLabel.textContent = `Listening… tap to send (${left}s)`
  }
  label()
  tick = setInterval(label, 1000)
  stopTimer = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORD_MS)
}

// ---------- push notifications ----------

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const sameKey = (a, b) => {
  if (!a || a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

async function currentSubscription() {
  if (!pushSupported()) return undefined
  const reg = await navigator.serviceWorker.getRegistration("/")
  return (await reg?.pushManager.getSubscription()) ?? undefined
}

async function updateNotifyButton() {
  const button = $("notify")
  if (!pushSupported() || !window.isSecureContext) return (button.hidden = true)
  if (Notification.permission === "denied") return (button.hidden = true)
  const sub = Notification.permission === "granted" ? await currentSubscription().catch(() => undefined) : undefined
  button.hidden = !!sub
}

async function enableNotifications() {
  const button = $("notify")
  button.disabled = true
  try {
    if (!pushSupported()) throw new Error("This browser does not support push notifications here. On iPhone, add the app to the Home Screen first (iOS 16.4+).")
    const permission = await Notification.requestPermission()
    if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in the browser's site settings.")
    await subscribePush()
    toast("Notifications are on")
  } catch (e) {
    toast(e.message, "err")
  } finally {
    button.disabled = false
    updateNotifyButton()
    if ($("sheet").open) renderSheet()
  }
}

async function subscribePush() {
  const { publicKey } = await getJSON("/api/push/key")
  const key = keyBytes(publicKey)
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } })
  return sub
}

async function disableNotifications() {
  const sub = await currentSubscription()
  if (sub) {
    await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
  toast("Notifications are off for this device")
  updateNotifyButton()
  renderSheet()
}

/** Keeps the server's copy of an existing subscription current (e.g. after a server state reset). */
async function syncPush() {
  if (!pushSupported() || Notification.permission !== "granted") return
  if (await currentSubscription().catch(() => undefined)) await subscribePush().catch(() => {})
}

// ---------- settings sheet ----------

async function renderSheet() {
  const body = $("sheet-body")
  if (state.sheetPanel === "speech") {
    if (!body.querySelector(".speech-panel")) renderSpeech()
    return
  }
  $("sheet-title").textContent = "Settings"
  const [prefsRes, devicesRes] = await Promise.all([getJSON("/api/push/prefs").catch(() => undefined), getJSON("/api/devices").catch(() => undefined)])
  const sub = await currentSubscription().catch(() => undefined)
  const sections = []

  // Notifications
  const notif = h("div", { class: "section" }, h("h3", {}, "Notifications"))
  const status = !pushSupported() || !window.isSecureContext
    ? "Not supported in this browser. On iPhone, add the app to the Home Screen (iOS 16.4+)."
    : Notification.permission === "denied"
      ? "Blocked in the browser's site settings."
      : sub ? "On for this device." : "Off for this device."
  notif.append(h("p", { class: "small muted", style: "margin:0 0 8px" }, status))
  if (pushSupported() && window.isSecureContext && Notification.permission !== "denied") {
    notif.append(
      sub
        ? h("button", { class: "btn small", type: "button", onclick: disableNotifications }, "Turn off on this device")
        : h("button", { class: "btn small primary", type: "button", onclick: enableNotifications }, "Enable notifications"),
    )
  }
  if (prefsRes) {
    const list = h("div", { class: "list", style: "margin-top:10px" })
    for (const [key, label] of [
      ["handoff", "Hand-offs from the terminal"],
      ["blocked", "Session needs permission or an answer"],
      ["finished", "Session finished (not voice turns)"],
      ["say", "Read agent replies as notifications when the phone is locked"],
    ]) {
      const input = h("input", { type: "checkbox", id: `pref-${key}` })
      input.checked = !!prefsRes.prefs[key]
      input.addEventListener("change", async () => {
        input.disabled = true
        try {
          await api("/api/push/prefs", { method: "PUT", json: { [key]: input.checked } })
        } catch (e) {
          input.checked = !input.checked
          toast(e.message, "err")
        } finally {
          input.disabled = false
        }
      })
      list.append(h("label", { class: "switch", for: `pref-${key}` }, h("span", {}, label), input))
    }
    notif.append(list)
  }
  sections.unshift(voiceSection(), speechEntry())
  sections.push(notif)

  // Pending machine requests
  if (state.enrollments.length) {
    sections.push(
      h("div", { class: "section" }, h("h3", {}, "Machines waiting for approval"),
        h("ul", { class: "list" }, state.enrollments.map((e) =>
          h("li", {},
            h("div", { class: "grow" }, h("div", { class: "name" }, e.machineName), h("div", { class: "small muted" }, `Code ${e.userCode}`)),
            h("button", { class: "btn small primary", type: "button", onclick: () => decideEnrollment(e, "approve") }, "Approve"),
            h("button", { class: "btn small danger", type: "button", onclick: () => decideEnrollment(e, "deny") }, "Deny"))))),
    )
  }

  // Machines
  const machines = state.machines ?? []
  sections.push(
    h("div", { class: "section" }, h("h3", {}, "Machines"),
      machines.length
        ? h("ul", { class: "list" }, machines.map((m) =>
            h("li", {},
              h("div", { class: "grow" },
                h("div", { class: "name" }, m.name),
                h("div", { class: "small muted" }, m.online ? "online" : `offline · seen ${ago(m.lastSeen)}`)),
              h("button", { class: "btn small danger", type: "button", "aria-label": `Revoke machine ${m.name}`, onclick: () => revokeMachine(m) }, "Revoke"))))
        : h("p", { class: "small muted" }, "None. In OpenCode run /voice → Connect this machine.")),
  )

  // Devices
  if (devicesRes) {
    sections.push(
      h("div", { class: "section" }, h("h3", {}, "Paired devices"),
        h("ul", { class: "list" }, devicesRes.devices.map((d) =>
          h("li", {},
            h("div", { class: "grow" },
              h("div", { class: "name" }, d.name, d.current ? h("span", { class: "muted" }, " · this device") : null),
              h("div", { class: "small muted" }, `last seen ${ago(d.lastSeen)}`)),
            h("button", { class: "btn small danger", type: "button", "aria-label": d.current ? "Sign out this device" : `Revoke device ${d.name}`, onclick: () => revokeDevice(d) }, d.current ? "Sign out" : "Revoke"))))),
    )
  }
  sections.push(h("p", { class: "small muted" }, `Server ${state.me?.publicURL ?? location.origin} · v${state.me?.version ?? "?"}`))
  if (state.sheetPanel !== "main") return // switched panels while loading
  body.replaceChildren(...sections)
}

/** A labeled checkbox row stored in localStorage; `onChange` gets the new value. */
function prefSwitch(id, key, label, checked, onChange, help) {
  const input = h("input", { type: "checkbox", id, "aria-describedby": help ? `${id}-help` : undefined })
  input.checked = checked
  input.addEventListener("change", () => {
    localStorage.setItem(key, input.checked ? "1" : "0")
    onChange?.(input.checked)
  })
  return h("li", { class: "switch-item" },
    h("label", { class: "switch", for: id }, h("span", {}, label), input),
    help ? h("p", { id: `${id}-help`, class: "small muted switch-help" }, help) : null)
}

function voiceSection() {
  const convo = () => state.session?.conversation
  return h("div", { class: "section" }, h("h3", {}, "Voice"),
    h("ul", { class: "list" },
      h("li", {}, speedControl("speed-sheet", "Voice speed")),
      prefSwitch("pref-cues", PREF_CUES, "Progress cues", prefs.cues, (on) => convo()?.setCues(on),
        "In conversation mode: a soft tone when the agent hears you, “Working on it.”, “Started a subagent.” and “Still working.”"),
      prefSwitch("pref-background", PREF_BACKGROUND, "Keep listening when screen is off", prefs.background, (on) => convo()?.setBackground(on),
        "Off: the screen stays on while listening. On: lock-screen controls and best-effort listening with the screen off (Android Chrome).")))
}

function speechEntry() {
  return h("div", { class: "section" }, h("h3", {}, "Speech"),
    h("button", { class: "btn small wide", type: "button", onclick: () => openSpeech() }, "Speech-to-text and text-to-speech providers ›"))
}

function openSpeech() {
  state.sheetPanel = "speech"
  renderSpeech()
}

/** Settings → Speech, opening the sheet first when it is closed. */
function openSpeechSettings() {
  state.sheetPanel = "speech"
  renderSpeech()
  if (!$("sheet").open) $("sheet").showModal()
}

// ---------- speech onboarding ----------

async function loadSpeechReady() {
  try {
    const settings = await getJSON("/api/settings/speech")
    setSpeechReady(settings.ready)
  } catch {
    state.speechReady = null // unknown (older hub, or not allowed): no banner
  }
}

function setSpeechReady(ready) {
  state.speechReady = ready ?? null
  if (state.route?.name === "home" && state.browser.els) renderHome()
  if (state.route?.name === "session" && state.session) applySpeechGate(state.session)
}

/** The "Set up speech" card for home and the session view; null when speech is ready. */
function speechBanner() {
  const setup = speechSetup(state.speechReady ?? undefined, state.me?.publicURL)
  if (!setup) return null
  return h("section", { class: "card banner speech-setup", "aria-label": "Set up speech" },
    h("div", { class: "stack-tight" },
      h("strong", {}, "Set up speech"),
      h("p", { class: "small" }, setup.reason),
      setup.storage ? h("p", { class: "small muted" }, setup.storage) : null),
    h("button", { class: "btn small primary", type: "button", onclick: openSpeechSettings }, "Set up speech"))
}

/** In a session: the banner, and the mic and conversation button off while speech-to-text is not usable. */
function applySpeechGate(s) {
  const els = s.els
  if (!els?.speechSetup) return
  const setup = speechSetup(state.speechReady ?? undefined, state.me?.publicURL)
  els.speechSetup.replaceChildren(...[speechBanner()].filter(Boolean))
  const blocked = !!setup?.micBlocked
  const wasBlocked = els.mic.dataset.speech === "off"
  els.mic.dataset.speech = blocked ? "off" : "on"
  els.convo.disabled = blocked
  els.mic.setAttribute("aria-label", blocked ? "Set up speech to talk" : "Start recording")
  if (blocked) els.micLabel.textContent = "Set up speech to talk (Settings → Speech). Typing works meanwhile."
  else if (wasBlocked) els.micLabel.textContent = "Tap to talk"
}

// ---------- settings: speech providers ----------

const PROVIDERS = [["openrouter", "OpenRouter"], ["openai-compatible", "OpenAI-compatible"]]
const KEY_SOURCE = { settings: "from settings", config: "from hub.json", env: "from env" }

async function renderSpeech() {
  const body = $("sheet-body")
  $("sheet-title").textContent = "Speech"
  const back = h("button", { class: "btn small", type: "button", onclick: () => {
    state.sheetPanel = "main"
    renderSheet()
    $("settings").focus()
  } }, "‹ Settings")
  const panel = h("div", { class: "speech-panel stack" }, back, h("p", { class: "muted" }, "Loading…"))
  body.replaceChildren(panel)
  back.focus()
  let settings
  try {
    settings = await getJSON("/api/settings/speech")
  } catch (e) {
    panel.replaceChildren(back, h("p", { class: "error", role: "alert" },
      e.status === 403 ? "Only the owner device can change speech settings." : e.status === 404 ? "This voice server does not support speech settings yet." : `Could not load speech settings: ${e.message}`))
    return
  }
  if (state.sheetPanel !== "speech") return
  speechEditor(panel, back, settings)
}

function speechEditor(panel, back, settings) {
  let form = speechForm(settings)
  const setup = speechSetup(settings.ready, state.me?.publicURL)
  const intro = setup
    ? h("div", { class: "card banner speech-setup" }, h("div", { class: "stack-tight" },
        h("strong", {}, "Speech is not set up yet"), h("p", { class: "small" }, setup.reason),
        h("p", { class: "small muted" }, "OpenRouter covers both directions with one key (openrouter.ai/keys). Or point both at your own OpenAI-compatible servers."),
        setup.storage ? h("p", { class: "small muted" }, setup.storage) : null))
    : null
  const status = h("p", { class: "small", role: "status" })
  const errorEls = new Map() // "stt.model" → <p>
  const inputs = new Map() // "stt.model" → input

  const field = (kind, name, label, control, { help, hidden } = {}) => {
    const key = `${kind}.${name}`
    const id = `sp-${kind}-${name}`
    control.id = id
    const err = h("p", { class: "field-error", id: `${id}-err` })
    errorEls.set(key, err)
    inputs.set(key, control)
    control.setAttribute("aria-describedby", [help ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" "))
    return h("div", { class: "field", hidden },
      h("label", { for: id }, label), control,
      help ? h("p", { class: "small muted field-help", id: `${id}-help` }, help) : null, err)
  }
  const text = (kind, name, attrs = {}) => {
    const input = h("input", { type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...attrs })
    input.value = form[kind][name]
    input.addEventListener("input", () => {
      form[kind][name] = input.value
      dirty()
    })
    return input
  }

  // Model lists are fetched once per editor (per kind); a failed fetch is retried on the next open.
  const modelLists = {}
  const models = (kind) => {
    modelLists[kind] ??= getJSON(`/api/settings/speech/models?kind=${kind}`).then(pickerOptions)
    modelLists[kind].catch(() => delete modelLists[kind])
    return modelLists[kind]
  }

  /** A button showing the field's value that opens the option picker; picking sets the form value. */
  const choice = (kind, name, { title, noun, load, onChange }) => {
    const button = h("button", { type: "button", class: "picker-btn", "aria-haspopup": "dialog" })
    const show = () => {
      const v = form[kind][name]
      button.replaceChildren(
        h("span", { class: "picker-value" }, v ? h("span", { class: "pv-id" }, v) : h("span", { class: "pv-empty" }, `Choose a ${noun}`)),
        h("span", { class: "picker-chev", "aria-hidden": "true" }, "›"))
      button.setAttribute("aria-label", `${noun[0].toUpperCase()}${noun.slice(1)}: ${v || "not set"}. Change`)
    }
    show()
    button.addEventListener("click", () =>
      openPicker({
        title,
        noun,
        current: form[kind][name],
        load,
        opener: button,
        onPick: (value) => {
          form[kind][name] = value
          show()
          dirty()
          onChange?.(value)
        },
      }))
    return button
  }

  const card = (kind) => {
    const info = settings[kind]
    const provider = h("select", {})
    for (const [value, label] of PROVIDERS) provider.append(h("option", { value }, label))
    if (!PROVIDERS.some(([v]) => v === form[kind].provider)) provider.append(h("option", { value: form[kind].provider }, form[kind].provider || "—"))
    provider.value = form[kind].provider
    const baseURL = text(kind, "baseURL", { inputmode: "url", placeholder: "http://host:port/v1" })
    const baseField = field(kind, "baseURL", "Base URL", baseURL, { hidden: form[kind].provider !== "openai-compatible" })
    provider.addEventListener("change", () => {
      form[kind].provider = provider.value
      baseField.hidden = provider.value !== "openai-compatible"
      dirty()
    })

    // Model and voice open a full-height picker sheet (a <datalist> shows nothing useful on Android Chrome).
    const modelHelp = h("span", {}, "Loading models…")
    const showModelCount = () =>
      models(kind).then(
        (list) => (modelHelp.textContent = list.length ? `${list.length} models available, or enter any model ID.` : "No model list from this provider; enter a model ID."),
        () => (modelHelp.textContent = "Model list unavailable; enter a model ID."),
      )
    showModelCount()
    let voiceButton
    const model = choice(kind, "model", {
      title: kind === "stt" ? "Speech-to-text model" : "Text-to-speech model",
      noun: "model",
      load: () => models(kind).finally(showModelCount),
      onChange: () => voiceButton?.refreshHelp(),
    })

    const fields = [
      field(kind, "provider", "Provider", provider),
      baseField,
      field(kind, "model", "Model", model, { help: " " }),
    ]
    fields[2].querySelector(".field-help").replaceChildren(modelHelp)

    if (kind === "tts") {
      const voiceOptions = () => pickerOptions(voicesFor(settings.voiceHints, form.tts.model))
      const voiceHelp = h("span", {})
      const voice = (voiceButton = choice(kind, "voice", { title: "Voice", noun: "voice", load: async () => voiceOptions() }))
      voice.refreshHelp = () => {
        const n = voiceOptions().length
        voiceHelp.textContent = n ? `${n} suggested voices for ${form.tts.model || "this model"}, or enter any voice name.` : "No suggestions for this model; enter a voice name."
      }
      voice.refreshHelp()
      const voiceField = field(kind, "voice", "Voice", voice, { help: " " })
      voiceField.querySelector(".field-help").replaceChildren(voiceHelp)
      fields.push(voiceField)
      fields.push(field(kind, "speed", "Server-side speed (optional)", text(kind, "speed", { inputmode: "decimal", placeholder: "default" }),
        { help: "0.25–4, applied by the TTS provider. The phone's voice speed is separate." }))
    } else {
      fields.push(field(kind, "language", "Language (optional)", text(kind, "language", { placeholder: "auto, e.g. en" })))
    }
    fields.push(keyField(kind, info.apiKey ?? { set: false, source: "none" }))
    return h("fieldset", { class: "card speech-card" },
      h("legend", {}, kind === "stt" ? "Speech-to-text" : "Text-to-speech"),
      ...fields)
  }

  const keyField = (kind, key) => {
    const id = `sp-${kind}-apiKey`
    const box = h("div", { class: "field key-field" })
    const err = h("p", { class: "field-error", id: `${id}-err` })
    errorEls.set(`${kind}.apiKey`, err)
    const draw = () => {
      const edit = form[kind].apiKey
      const label = h("span", { class: "field-label", id: `${id}-label` }, "API key")
      if (edit.action === "set") {
        const input = h("input", { type: "password", id, autocomplete: "new-password", "aria-describedby": `${id}-err`, placeholder: "Paste the new key" })
        inputs.set(`${kind}.apiKey`, input)
        input.addEventListener("input", () => {
          edit.value = input.value
          dirty()
        })
        box.replaceChildren(h("label", { for: id }, "New API key"), input,
          h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => {
            form[kind].apiKey = { action: "keep", value: "" }
            draw()
            dirty()
          } }, "Cancel")), err)
        input.focus()
        return
      }
      const summary = edit.action === "clear"
        ? "Key will be removed when you save."
        : key.set ? `Key set${key.last4 ? ` ••••${key.last4}` : ""} (${KEY_SOURCE[key.source] ?? key.source})` : "No key set"
      const buttons = [h("button", { class: "btn small", type: "button", "aria-describedby": `${id}-label ${id}-summary`, onclick: () => {
        form[kind].apiKey = { action: "set", value: "" }
        draw()
        dirty()
      } }, key.set ? "Replace" : "Add key")]
      if (edit.action === "clear") {
        buttons.push(h("button", { class: "btn small", type: "button", onclick: () => {
          form[kind].apiKey = { action: "keep", value: "" }
          draw()
          dirty()
        } }, "Undo"))
      } else if (key.set && key.source === "settings") {
        buttons.push(h("button", { class: "btn small danger", type: "button", "aria-describedby": `${id}-label`, onclick: () => {
          form[kind].apiKey = { action: "clear", value: "" }
          draw()
          dirty()
        } }, "Clear"))
      }
      box.replaceChildren(label, h("p", { class: "key-summary", id: `${id}-summary` }, summary), h("div", { class: "row" }, ...buttons), err)
    }
    draw()
    return box
  }

  const save = h("button", { class: "btn primary", type: "submit" }, "Save")
  const preview = h("button", { class: "btn", type: "button", "data-preview": true, onclick: () => previewVoice(preview, status, () => Object.keys(speechPatch(settings, form)).length > 0) }, "Preview voice")
  const formEl = h("form", { class: "stack", novalidate: true }, card("stt"), card("tts"), h("div", { class: "row" }, save, preview), status)

  function dirty() {
    status.textContent = Object.keys(speechPatch(settings, form)).length ? "Unsaved changes." : ""
    status.className = "small muted"
  }
  function showErrors(errors) {
    for (const [key, el] of errorEls) {
      el.textContent = errors[key] ?? ""
      const input = inputs.get(key)
      if (input) input.toggleAttribute("aria-invalid", !!errors[key])
    }
  }

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault()
    const errors = validateSpeech(form)
    showErrors(errors)
    const first = Object.keys(errors)[0]
    if (first) {
      status.textContent = "Fix the highlighted fields."
      status.className = "small error"
      return inputs.get(first)?.focus()
    }
    const patch = speechPatch(settings, form)
    if (!Object.keys(patch).length) {
      status.textContent = "Nothing to save."
      status.className = "small muted"
      return
    }
    save.disabled = true
    status.textContent = "Saving…"
    status.className = "small muted"
    try {
      const res = await (await api("/api/settings/speech", { method: "PUT", json: patch })).json().catch(() => ({}))
      const next = res?.stt && res?.tts ? res : await getJSON("/api/settings/speech")
      const nowReady = !!next.ready?.tts && !settings.ready?.tts
      setSpeechReady(next.ready)
      if (state.sheetPanel !== "speech") return
      speechEditor(panel, back, next)
      const done = panel.querySelector('p[role="status"]')
      done.textContent = nowReady ? "Saved. Now test your voice: press Test voice." : "Saved."
      done.className = "small ok"
      toast("Speech settings saved")
      if (nowReady) {
        const test = panel.querySelector("[data-preview]")
        if (test) {
          test.textContent = "Test voice"
          test.classList.add("primary")
          test.focus()
        }
      }
    } catch (e) {
      save.disabled = false
      if (e.field && errorEls.has(e.field)) showErrors({ [e.field]: e.message })
      status.textContent = `Could not save: ${e.message}`
      status.className = "small error"
    }
  })
  panel.replaceChildren(...[back, intro, formEl].filter(Boolean))
}

// ---------- option picker (full-height sheet with search) ----------

const picker = {
  dialog: $("picker"),
  input: $("picker-input"),
  list: $("picker-list"),
  status: $("picker-status"),
  retry: $("picker-retry"),
  run: 0, // open count, to ignore loads of an earlier opening
  opts: undefined, // { noun, current, load, onPick, opener }
  options: undefined, // loaded options, undefined while loading
  error: undefined, // load error message
  rows: [], // rendered choices: { value, el }
  active: -1,
}

/**
 * Opens the picker: a search box, the options from `load()` (id + name; the current one marked), and "Use “…”"
 * for typed text, with loading / error (Retry) / empty states. Picking calls `onPick(value)` and closes; focus
 * returns to `opener`. Keyboard: arrows / Home / End move, Enter picks, Escape closes.
 */
function openPicker({ title, noun, current, load, onPick, opener }) {
  picker.opts = { noun, current: current ?? "", load, onPick, opener }
  $("picker-title").textContent = title
  picker.input.value = ""
  picker.input.placeholder = `Search or type a ${noun}`
  picker.input.setAttribute("aria-label", `Search ${noun}s`)
  picker.active = -1
  if (!picker.dialog.open) picker.dialog.showModal()
  loadPicker()
  picker.input.focus()
}

async function loadPicker() {
  const run = ++picker.run
  picker.options = undefined
  picker.error = undefined
  renderPicker()
  try {
    const options = await picker.opts.load()
    if (run !== picker.run) return
    picker.options = options
  } catch (e) {
    if (run !== picker.run) return
    picker.error = e.message || "failed"
  }
  renderPicker()
}

function renderPicker() {
  const { noun, current } = picker.opts
  const query = picker.input.value
  const result = filterPicker(picker.options ?? [], query, { current })
  const rows = []
  const option = (value, id, children, { selected = false, cls = "" } = {}) => {
    const el = h("li", { id, class: `picker-opt${cls}`, role: "option", "aria-selected": String(selected), onclick: () => pickValue(value) }, children)
    rows.push({ value, el })
    return el
  }
  const items = result.items.map((item, i) =>
    option(item.id, `picker-opt-${i}`, [
      h("span", { class: "po-id" }, item.id),
      item.name ? h("span", { class: "po-name" }, item.name) : null,
      item.current ? h("span", { class: "po-mark" }, "✓ Current") : null,
    ], { selected: !!item.current }))
  if (result.custom) {
    items.push(option(result.custom, "picker-opt-custom", [h("span", { class: "po-id" }, `Use “${result.custom}”`), h("span", { class: "po-name" }, `as a custom ${noun}`)], { cls: " custom" }))
  }
  picker.rows = rows
  picker.list.replaceChildren(...items)
  const loaded = picker.options !== undefined
  picker.retry.hidden = !picker.error
  let status
  if (picker.error) status = `Couldn't load the ${noun} list: ${picker.error}. Type any ${noun}, or retry.`
  else if (!loaded) status = `Loading ${noun}s…`
  else if (!picker.options.length) status = `No suggestions from this provider. Type any ${noun}.`
  else if (!result.total) status = `No ${noun}s match. Use what you typed, or change the search.`
  else status = result.more ? `Showing ${result.items.length} of ${result.total}; keep typing to narrow.` : `${result.total} ${result.total === 1 ? noun : `${noun}s`}`
  if (picker.status.textContent !== status) picker.status.textContent = status
  setActive(rows.length ? Math.min(Math.max(picker.active, 0), rows.length - 1) : -1)
}

function setActive(index) {
  picker.rows[picker.active]?.el.classList.remove("active")
  picker.active = index
  const row = picker.rows[index]
  if (!row) return picker.input.removeAttribute("aria-activedescendant")
  row.el.classList.add("active")
  picker.input.setAttribute("aria-activedescendant", row.el.id)
  row.el.scrollIntoView({ block: "nearest" })
}

function pickValue(value) {
  const { onPick } = picker.opts
  picker.dialog.close()
  onPick(value)
}

picker.input.addEventListener("input", () => {
  picker.active = 0
  renderPicker()
})
picker.input.addEventListener("keydown", (event) => {
  const moves = { ArrowDown: 1, ArrowUp: -1, Home: "home", End: "end" }
  if (event.key in moves && (event.key.startsWith("Arrow") || !picker.input.value)) {
    event.preventDefault()
    setActive(stepActive(picker.active, moves[event.key], picker.rows.length))
  } else if (event.key === "Enter") {
    event.preventDefault()
    const row = picker.rows[picker.active]
    if (row) pickValue(row.value)
  }
})
picker.retry.addEventListener("click", () => {
  loadPicker()
  picker.input.focus()
})
$("picker-close").addEventListener("click", () => picker.dialog.close())
picker.dialog.addEventListener("click", (event) => {
  if (event.target === picker.dialog) picker.dialog.close() // backdrop tap
})
picker.dialog.addEventListener("close", () => {
  picker.run++
  const opener = picker.opts?.opener
  if (opener?.isConnected) opener.focus()
})

async function previewVoice(button, status, unsaved) {
  button.disabled = true
  status.textContent = unsaved() ? "Previewing the saved voice (save to hear your changes)…" : "Previewing…"
  status.className = "small muted"
  let url
  try {
    const blob = await (await api("/api/settings/speech/test", { method: "POST", json: { kind: "tts", text: "Hi! This is how replies will sound." } })).blob()
    url = URL.createObjectURL(blob)
    player.src = url
    applyRate(player, prefs.speed)
    if (!(await player.play().then(() => true, () => false))) throw new Error("the browser blocked playback")
    status.textContent = "Playing preview."
    await new Promise((resolve) => {
      player.onended = player.onpause = player.onerror = () => resolve()
    })
    status.textContent = ""
  } catch (e) {
    status.textContent = `Preview failed: ${e.message}`
    status.className = "small error"
  } finally {
    player.onended = player.onpause = player.onerror = null
    if (url) URL.revokeObjectURL(url)
    button.disabled = false
  }
}

async function decideEnrollment(e, action) {
  try {
    await api(`/api/enrollments/${encodeURIComponent(e.userCode)}/${action}`, { method: "POST", json: {} })
    toast(action === "approve" ? `${e.machineName} approved` : "Request denied")
  } catch (err) {
    toast(err.message, "err")
  }
  loadEnrollments()
}

async function revokeMachine(m) {
  if (!confirm(`Revoke ${m.name}? Its OpenCode processes disconnect and it must be connected again.`)) return
  try {
    await api(`/api/machines/${encodeURIComponent(m.id)}`, { method: "DELETE" })
    toast(`${m.name} revoked`)
  } catch (e) {
    toast(e.message, "err")
  }
  renderSheet()
}

async function revokeDevice(d) {
  if (d.current) {
    if (!confirm("Sign out this device? You will need a new pairing code.")) return
    const sub = await currentSubscription().catch(() => undefined)
    await sub?.unsubscribe().catch(() => {})
    await api("/api/logout", { method: "POST", json: {} }).catch(() => {})
    state.source?.close()
    state.source = undefined
    state.me = undefined
    $("sheet").close()
    return navigate("/pair", { replace: true })
  }
  if (!confirm(`Revoke ${d.name}?`)) return
  try {
    await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" })
    toast(`${d.name} revoked`)
  } catch (e) {
    toast(e.message, "err")
  }
  renderSheet()
}

// ---------- wiring ----------

$("back").addEventListener("click", () => (state.pushed > 0 ? history.back() : navigate("/")))
$("notify").addEventListener("click", enableNotifications)
$("settings").addEventListener("click", () => {
  renderSheet()
  $("sheet").showModal()
})
$("sheet-close").addEventListener("click", () => $("sheet").close())
$("sheet").addEventListener("close", () => (state.sheetPanel = "main"))
$("sheet").addEventListener("click", (event) => {
  if (event.target === $("sheet")) $("sheet").close() // backdrop tap
})

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => syncPush()).catch((e) => console.warn("service worker:", e.message))
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "navigate" && typeof event.data.url === "string") {
      const url = new URL(event.data.url, location.origin)
      if (url.origin === location.origin) navigate(url.pathname + url.search)
    }
  })
}

applyRate(player, prefs.speed)

// Relative times drift; refresh the home list once a minute.
setInterval(() => state.route?.name === "home" && state.machines && renderHome(), 60_000)

render()
