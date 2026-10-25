#!/usr/bin/env bun
// Mock hub for manual/browser checks of the console (not a test file): serves the built web/dist (run
// `npm run build:web` first) and fakes
// the hub API + SSE per the conversation contract. Usage: `bun test/web-mock-hub.ts [port]` (default 4311).
// Control: POST /mock/transcripts {texts: string[]} (queued /api/transcribe answers; POST /mock/reset-transcripts empties the queue), POST /mock/emit {…SSE message},
// POST /mock/status {sessions} (status tree of ses_mock, root first; emitted as SSE status; children with a
// parentID open as subagent sessions: their console routes answer like ses_mock's, no process lists them),
// POST /mock/activity {sessionID?, item} (stored for GET /api/sessions/ses_mock and emitted as SSE activity),
// GET /mock/log (recorded API calls), POST /mock/reset, POST /mock/workstation {on} (a second online machine), POST /mock/push {endpoints} (the push subscriptions the hub holds).
// Also fakes presence, push prefs (incl. `say`), devices and the speech settings API (keys masked as last4).
// Session browser (VF6): ~40 sessions on "laptop" (6 workspaces incl. worktrees, blocked/working/unexposed ones,
// a standalone process) plus an offline machine. Sessions carry exposed/project/projectName/now/state/blockers;
// POST /api/sessions/:id/expose {on}; 403 {code:"not_exposed"} from session endpoints of unexposed sessions;
// POST /api/machines/:id/sessions {directory, title?} → 201 {sessionID}. Control: POST /mock/session {id, ...patch}
// (patch a session and emit a catalog), POST /mock/fail {expose?, create?, models?} (make those calls fail),
// POST /mock/service {connected} (409 for create while false).
// Streaming: POST /mock/stream {sessionID?, kind: "text"|"reasoning", messageID, text, every?, size?} emits the text in
// chunks as SSE delta/reasoning (with rootID ses_mock); ses_mock text in conversation mode is also spoken like the hub
// does it (a say per completed sentence with seq, the rest when the text ends; GET /mock/log lists `textEnded`
// times; /api/speak streams a 2 s MP3 in 12 chunks over ~1.2 s, its log entry's `done` says when the last was sent);
// POST /mock/scenario {say?} plays a scripted run of ses_mock: root
// reasoning, a shell tool, two subagents (ses_mock_kid, ses_mock_kid2) streaming their output, root reply text (and say
// events when conversation mode is on), then idle. Status entries of working sessions carry `since`.
// Multi-user (0.3.0, docs/multi-user.md): POST /mock/auth {mode?: "pairing"|"oidc", as?: userID} switches the auth mode
// and who the fake GET /auth/login signs in (u_alice admin, u_bob user; u_carol is disabled). The `mock_user` cookie
// holds the signed-in user ID ("out" = signed out); without it, pairing mode is the implicit owner `local` (as
// before) and oidc mode answers 401. Pairing code 123456 works in both modes. GET /api/auth, /api/me with user+auth,
// per-user catalog/SSE/sessions (bob owns "bob-laptop" with ses_bob; other sessions are 404 for him), own devices,
// per-user speech (GET/PUT /api/settings/speech with scope/default/user) and the server default
// (/api/settings/speech/default, admin), admin users/machines/devices/audit, admin-only GET /api/enrollments with
// two pending machines, and GET /auth/callback?error=… rendering the hub's error page.
// Session view (0.4.0, docs/session-view.md): "laptop" reports Herdr (machine.terminals.herdr: general, api-server,
// research, ops, scratch) and 14 open sessions (13 in Herdr panes, one in a TUI) besides ~40 history sessions;
// blocked ones open and in history. GET/PUT /api/prefs/view per user (PUT emits SSE {type:"prefs", prefs} to that
// user's clients); POST /api/machines/:id/sessions accepts herdrWorkspace (201 {sessionID, openedIn:"herdr"}, or with
// a warning and no openedIn when Herdr fails). Control: POST /mock/prefs {…lists} (another device changed prefs:
// stored and emitted), POST /mock/herdr {on?, fail?} (machine without Herdr; Herdr tab creation fails),
// POST /mock/fail {prefs?} (PUT /api/prefs/view answers 502).
// Console (0.5): every session is inspectable and controllable with Voice off (only conversation and utterance
// answer 403 not_exposed); GET …/timeline (+ parts), …/model-prefs (GET/PUT), …/models, …/summary, …/diff?file=,
// GET …/timeline/messages/:message/files/:index (a 1×1 PNG; ses_mock's first user message lists one image),
// GET …/messages (hub messages: ses_mock sent an ask to @@reviewer; its history has a primer and a message from @web-work),
// POST …/read (GET /api/reads), …/stop, …/permission, …/form {formID, answer|cancel} (409 gone when not pending); POST …/turn {text, images?} (up to 4 PNG/JPEG/WebP/GIF images;
// text may be empty with images; the log keeps each image's mime, name and base64 length) answers 202 {mode:"steer"} while the tree runs,
// else runs the turn (ses_mock: working → streamed reply → idle; text containing "fail" → 409). With
// `Prefer: respond-async` (as the hub) a ses_mock turn still running after 1.5 s answers 202 {mode:"turn"} and its
// result follows as an SSE {type:"turn"} event. POST /mock/slow-turns {ms} sets how long a ses_mock turn works.
// POST /api/sessions/:id/rename {title} (history fixtures; 400 blank or over 200 characters; POST /mock/fail {rename}
// answers 502) sets the title and emits a catalog. Auto-name: {auto: true} waits 600 ms, then follows POST /mock/auto-name
// {mode?, title?}: "rename" (default) sets `title` (default "Named by OpenCode") and answers {title}; "same" answers
// {title, unchanged}; "pending" answers 202 {pending} and sets the title 1.5 s later; "outdated" answers 409
// plugin_outdated; "fail" answers 502.
// POST /mock/hold-turns {on} keeps a ses_mock turn working until it is stopped (or the hold is lifted), so a test
// can steer and stop it without racing the turn's timer.
// Progressive history: GET …/timeline pages like the spoke (src/spoke/timeline.ts newestPage: ?order=desc for the
// newest page, ?before=<older> for the page before; ?cursor= forward pages as before). POST /mock/big {on, messages?,
// delayMs?, failOlder?, append?} lists "Long history" (ses_big, in /home/user/research) whose timeline has about
// 1000 rows (`messages` messages, default 900); older pages wait `delayMs` and answer 502 while `failOlder`;
// `append` adds that many messages at the end. The log keeps each request's query string.
// Timeline order: POST /mock/order {on?, live?} lists "Subagent order" (ses_order), whose history is the spoke's rows of
// a trimmed real session (test/fixtures/timeline-subagents-session.json, up to the turn that spawns S3 and S6) and
// whose status tree lists its finished subagents (no `since`); `live` then plays that turn as SSE events (reasoning,
// text with ordinal, tool activity, two subagents spawned with their child session, finishing later) and adds its
// messages to the history.
// Decisions (P2-T10b, hub ask @me): GET /api/decisions?state=, GET /api/decisions/:id, POST /api/decisions/:id/answer
// {option?, text?} (409 gone unless open; emits SSE {type:"decision"}). Control: POST /mock/decision {id?, silent?,
// …fields} opens or patches one (defaults: from @mock about ses_mock, options Proceed / Hold (safe), Hold
// recommended) and emits it as an SSE 'decision' unless `silent` (e.g. answered elsewhere, for the 409 path).
// Agents (P3-T12, /api/agent/*, one set for every user): GET/POST /api/agent/grants, PUT/DELETE …/:id (the hub's
// {error: {code, message}} envelope: 400 invalid for a bad holder/project/verb/expiry/cap, 404 for holder @ghost,
// 400 when an edit changes the holder, 410 gone for an ended grant); GET/PUT /api/agent/acting {enabled, hubEnabled};
// admin GET/PUT /api/admin/agents/acting {enabled}; GET /api/agent/audit?limit&before (newest first, `next`).
// Control: POST /mock/agent-entry {…entry fields} records an audit entry (seq, at filled in; default @orchestrator
// approved per_1 in ses_mock under g_mock) and emits it as SSE {type:"agent", entry}; POST /mock/agent-entries
// {count} records that many filler entries (paging); GET /mock/log lists `grants` and `agentAudit`.
// Harness controls (P7-T10): POST /mock/harness {on} lists two non-OpenCode processes on "laptop": a Claude Code service
// (evidence hooks, announcing only permission + stop) with "Claude refactor" (CC_SESSION: blocked on a permission and a
// question form), and an aider preset (evidence screen, announcing only turn) with "Aider fixes" (PRESET_SESSION, idle).
// Their console routes answer like the hub: 409 {code: "unsupported"} for an op their process does not announce (a turn
// to a running tree needs steer); a preset turn is 202 {mode: "turn"} (never confirmed). POST /mock/unsupported
// {features} makes those features unsupported for them too (a spoke that reconnected with fewer features).
// MOCK_WEB_DIST serves another built console instead of web/dist (to measure an older build).
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { SentenceStream } from "../src/central/say-stream"
import { DEFAULT_PUSH_PREFS } from "../src/central/store"
import { newestPage, timelineItems } from "../src/spoke/timeline"
import orderSession from "./fixtures/timeline-subagents-session.json"
import { speechModelList } from "../src/central/speech/models"
import gatewayModels from "./fixtures/openai-compatible-gateway-models.json"

const WEB = path.resolve(process.env.MOCK_WEB_DIST ?? path.join(import.meta.dir, "..", "web", "dist"))
const PORT = Number(process.argv[2] ?? 4311)
const SESSION = "ses_mock"
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
}

type Log = { at: number; method: string; path: string; query?: string; contentType?: string; bytes?: number; body?: unknown; done?: number }

/** A 2 s MP3 tone standing in for TTS audio; /api/speak streams it slowly (the log's `done`: when it was all sent). */
const TONE_MP3 = new Uint8Array(readFileSync(path.join(import.meta.dir, "fixtures", "tone.mp3")))
const SPEAK_CHUNKS = 12
const SPEAK_EVERY_MS = 100
let log: Log[] = []
let transcripts: string[] = []
let conversation = false
let inbox = 0
type Status = { id: string; title: string; state: string; blockers: unknown[]; parentID?: string; since?: number }
let status: Status[] = [{ id: SESSION, title: "Mock session", state: "idle", blockers: [] }]
let activity: Array<Record<string, unknown>> = []
type Fixture = {
  /** The machine reporting it (default mac_1). */
  machine?: string
  id: string
  title: string
  directory: string
  project?: string
  projectName?: string
  updated: number
  exposed: boolean
  conversation?: boolean
  state: string
  blockers: Array<Record<string, unknown>>
  now?: { kind: string; tool?: string; summary?: string }
  open?: boolean
  terminal?: { source: "herdr" | "tui"; workspaceID?: string; workspace?: string; title?: string; status?: string }
  /** Its status tree (root first), when it has subagents. */
  tree?: Status[]
  /** The non-OpenCode process reporting it (HARNESS_PROCS id; P7-T10). */
  proc?: string
}
const HOME = "/home/user/projects"
const WORKSPACES: Array<[string, string]> = [
  [`${HOME}/opencode-voice`, "opencode-voice"],
  [`${HOME}/webshop`, "webshop"],
  ["/home/user/dotfiles", "dotfiles"],
  [`${HOME}/infra`, "infra"],
  [`${HOME}/pcb-designs`, "pcb-designs"],
  [`${HOME}/cafe-blog`, "café-blog"],
  [`${HOME}/api-server`, "api-server"],
  ["/home/user/research", "research"],
]
/** Herdr workspaces on "laptop", in Herdr's order (its sidebar numbers). */
const HERDR = [
  { id: "w_gen", label: "general", directories: [`${HOME}/opencode-voice`, "/home/user/dotfiles"] },
  { id: "w_api", label: "api-server", directories: [`${HOME}/api-server`, `${HOME}/api-server/.worktrees/feat-auth`] },
  { id: "w_res", label: "research", directories: ["/home/user/research"] },
  { id: "w_ops", label: "ops", directories: [`${HOME}/infra`] },
  { id: "w_scr", label: "scratch", directories: [] },
]
const herdrStatus = (state: string) => (state === "working" ? "working" : state === "blocked" ? "blocked" : "idle")
/** Marks a fixture as open in a Herdr pane of workspace `id` (status follows the session state). */
const inHerdr = (id: string, title?: string) => (f: Fixture): Partial<Fixture> => ({
  open: true,
  terminal: { source: "herdr", workspaceID: id, workspace: HERDR.find((w) => w.id === id)!.label, title: title ?? f.title, status: herdrStatus(f.state) },
})
const projectOf = (dir: string) => WORKSPACES.find(([root]) => dir === root || dir.startsWith(`${root}/`))
/** A question tool form (OpenCode form.created → the hub's form blocker with its fields). */
const QUESTION_FORM = {
  id: "q_1",
  kind: "form",
  question: true,
  summary: "Questions",
  fields: [
    { key: "q0", type: "string", title: "Subdomain", description: "Which subdomain should the dashboard use?", options: [{ value: "dash", label: "dash", description: "dash.example.com" }, { value: "ops", label: "ops" }], custom: true },
    { key: "q1", type: "multiselect", title: "Extras", description: "Anything else to set up?", options: [{ value: "tls", label: "TLS" }, { value: "auth", label: "Auth" }] },
  ],
}
function fixtures(): Fixture[] {
  const t = Date.now()
  const out: Fixture[] = []
  const add = (dir: string, title: string, minutes: number, extra: Partial<Fixture> = {}, open?: (f: Fixture) => Partial<Fixture>) => {
    const ws = projectOf(dir)
    const f: Fixture = { id: `ses_${String(out.length + 1).padStart(2, "0")}`, title, directory: dir, project: ws?.[0], projectName: ws?.[1], updated: t - minutes * 60_000, exposed: true, state: "idle", blockers: [], ...extra }
    out.push(open ? { ...f, ...open(f) } : f)
  }
  const ov = `${HOME}/opencode-voice`
  add(ov, "Session browser on the phone", 3, { state: "blocked", blockers: [{ id: "per_1", kind: "permission", summary: "shell: rm -rf web/dist" }] }, inHerdr("w_gen"))
  add(ov, "Hub SSE reconnect", 40, {}, inHerdr("w_gen"))
  add(ov, "README local-only section", 60 * 20)
  add(ov, "", 60 * 30)
  add(`${ov}/.worktrees/feat-voice-feedback`, "Voice speed slider", 1, { state: "working", conversation: true, now: { kind: "tool", tool: "shell", summary: "bun test" } }, () => ({ open: true, terminal: { source: "tui" } }))
  add(`${ov}/.worktrees/feat-voice-feedback`, "Progress cues", 90)
  add(`${ov}/.worktrees/feat-voice-feedback`, "Screen-off listening", 60 * 26)
  add(`${ov}/.worktrees/fix-sse`, "Fix SSE keepalive", 15, { state: "working", now: { kind: "thinking" } })
  add(`${ov}/.worktrees/fix-sse`, "SSE backoff", 60 * 50)
  add(`${ov}/web`, "PWA icons", 60 * 72, { exposed: false })
  const shop = `${HOME}/webshop`
  for (const [i, title] of ["Checkout migration", "Search ranking", "Cart bug", "Image resizing", "Orders API", "CLI polish"].entries()) {
    add(shop, title, 7 + i * 95, i === 1 ? { state: "working", now: { kind: "tool", tool: "edit", summary: "internal/search/rank.go" } } : i === 2 ? { state: "blocked", blockers: [{ id: "q_cart", kind: "question", summary: "Keep the old cart cookie for a release?" }] } : i >= 4 ? { exposed: false } : {})
  }
  add(`${shop}/.worktrees/feat-x`, "Feature X spike", 25)
  add(`${shop}/.worktrees/feat-x`, "Feature X tests", 200, { exposed: false })
  for (const [i, title] of ["editor config", "shell setup", "tmux keybinds", "zsh prompt", "opencode agents", "git aliases"].entries()) {
    add("/home/user/dotfiles", title, 60 * (2 + i * 9), i > 1 ? { exposed: false } : {})
  }
  const infra = `${HOME}/infra`
  add(infra, "Reverse proxy route for dashboard", 12, { state: "blocked", blockers: [QUESTION_FORM] }, inHerdr("w_ops"))
  add(infra, "Nightly backup job", 60 * 5, {}, inHerdr("w_ops"))
  add(infra, "Grafana alert rules", 8, { state: "working", now: { kind: "tool", tool: "edit", summary: "alerts/disk.yaml" } }, inHerdr("w_ops"))
  add(infra, "DNS server upgrade", 60 * 30, { exposed: false })
  add(`${infra}/ansible`, "Inventory cleanup", 60 * 8)
  add(infra, "Snapshot audit", 60 * 100)
  const pcb = `${HOME}/pcb-designs`
  add(pcb, "Café röuter board", 33)
  add(pcb, "Stitching vias", 60 * 7, { state: "working", now: { kind: "tool", tool: "shell", summary: "make drc" } })
  add(pcb, "Gerber export", 60 * 48)
  add(`${pcb}/motor-driver`, "Motor driver layout", 60 * 9, { exposed: false })
  const site = `${HOME}/cafe-blog`
  add(site, "Résumé page", 60 * 3)
  add(site, "Dark mode", 60 * 36)
  add(site, "Static deploy", 60 * 80)
  for (let i = 0; i < 6; i++) add(`${ov}/test-project`, `Test project run ${i + 1}`, 60 * (100 + i * 12), { exposed: i % 2 === 0 })
  const api = `${HOME}/api-server`
  add(api, "Rate limiter migration", 2, { state: "blocked", blockers: [{ id: "per_api", kind: "permission", summary: "shell: psql -f migrations/042_rate_limits.sql" }] }, inHerdr("w_api"))
  add(`${api}/.worktrees/feat-auth`, "Auth middleware", 1, { state: "working", now: { kind: "tool", tool: "shell", summary: "go test ./internal/auth/..." } }, inHerdr("w_api"))
  add(api, "OpenAPI docs", 55, {}, inHerdr("w_api"))
  add(api, "", 70, {}, inHerdr("w_api", "Pagination bug"))
  add(api, "Request logging", 60 * 30)
  add(api, "Health check endpoint", 60 * 60)
  const research = "/home/user/research"
  add(research, "Vector DB comparison", 4, { state: "working", now: { kind: "thinking" } }, inHerdr("w_res"))
  add(research, "Paper notes: retrieval", 35, {}, inHerdr("w_res"))
  add(research, "Benchmark harness", 120, {}, inHerdr("w_res"))
  add(research, "Reading list", 60 * 200)
  return out
}
let sessions = fixtures()
let created = 0
let fail = { expose: false, create: false, models: false, prefs: false, modelPrefs: false, rename: false }
let serviceConnected = true
const defaultAutoName = () => ({ mode: "rename" as "rename" | "same" | "pending" | "outdated" | "fail", title: "Named by OpenCode" })
let autoName = defaultAutoName()
/** Non-OpenCode processes on "laptop" (P7-T10); POST /mock/harness {on}. */
let harnessSpokes = false
let forcedUnsupported = new Set<string>()
const CC_SESSION = "ses_cc0123456789abcdef0123456789abcdef"
const PRESET_SESSION = "ses_preset_aider"
const HARNESS_PROCS = [
  { id: "proc_cc", kind: "service", directory: "/home/user", pid: 6161, harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks", features: ["permission", "stop"] },
  { id: "proc_preset", kind: "standalone", directory: `${HOME}/webshop`, pid: 6262, harness: "aider", harnessVersion: "0.86.1", evidence: "screen", features: ["turn"] },
]
const harnessFixtures = (): Fixture[] => [
  {
    machine: "mac_1",
    proc: "proc_cc",
    id: CC_SESSION,
    title: "Claude refactor",
    directory: `${HOME}/opencode-voice`,
    project: `${HOME}/opencode-voice`,
    projectName: "opencode-voice",
    updated: Date.now() - 60_000,
    exposed: true,
    state: "blocked",
    blockers: [{ id: "per_cc", kind: "permission", summary: "shell: npm publish" }, { ...QUESTION_FORM, id: "q_cc" }],
  },
  { machine: "mac_1", proc: "proc_preset", id: PRESET_SESSION, title: "Aider fixes", directory: `${HOME}/webshop`, project: `${HOME}/webshop`, projectName: "webshop", updated: Date.now() - 5 * 60_000, exposed: true, state: "idle", blockers: [] },
]
/** The console route's feature (the hub's core op or optional feature) for a harness session; undefined: always served. */
function routeFeature(route: string, id: string): string | undefined {
  if (route === "turn") return treeState(id) !== "idle" ? "steer" : "turn"
  return ({ timeline: "timeline", "model-prefs": "modelPrefs", models: "models", summary: "summary", diff: "diff", stop: "stop", permission: "permission", form: "form" } as Record<string, string>)[route]
}

/** A second online machine ("workstation", mac_5) with its own service and one session; POST /mock/workstation {on}. */
let workstation = false
const WORKSTATION_DIR = "/home/user/work/ml-lab"
let herdr = { on: true, fail: false }
type ViewPrefs = { hiddenSessions: string[]; hiddenWorkspaces: string[]; pinnedSessions: string[]; pinnedWorkspaces: string[] }
const PREF_LISTS = ["hiddenSessions", "hiddenWorkspaces", "pinnedSessions", "pinnedWorkspaces"] as const
const emptyPrefs = (): ViewPrefs => ({ hiddenSessions: [], hiddenWorkspaces: [], pinnedSessions: [], pinnedWorkspaces: [] })
let viewPrefs = new Map<string, ViewPrefs>()
const prefsOf = (userID: string) => {
  if (!viewPrefs.has(userID)) viewPrefs.set(userID, emptyPrefs())
  return viewPrefs.get(userID)!
}
/** Applies a partial prefs body; returns an error message for invalid input. */
function applyPrefs(userID: string, body: Record<string, unknown>): string | undefined {
  const prefs = prefsOf(userID)
  for (const list of PREF_LISTS) {
    const value = body[list]
    if (value === undefined) continue
    const max = list === "hiddenSessions" ? 5000 : 500
    if (!Array.isArray(value) || value.length > max || !value.every((x) => typeof x === "string" && x.length <= 4096)) return `${list} must be a list of at most ${max} strings`
  }
  for (const list of PREF_LISTS) if (body[list] !== undefined) prefs[list] = [...new Set(body[list] as string[])]
  return undefined
}
const NOT_EXPOSED = { error: "Voice is not enabled for this session. Enable it from the session list.", code: "not_exposed" }
const fixtureStatus = (s: Fixture) => s.tree ?? [{ id: s.id, title: s.title, state: s.state, blockers: s.blockers }]
const catalogSession = (s: Fixture) => ({ ...s, owned: false, busy: false, conversation: !!s.conversation, status: fixtureStatus(s) })
const mockSession = () => ({
  id: SESSION,
  title: "Mock session",
  directory: `${HOME}/opencode-voice`,
  project: `${HOME}/opencode-voice`,
  projectName: "opencode-voice",
  updated: Date.now(),
  owned: true,
  busy: false,
  exposed: true,
  conversation,
  state: status[0]?.state ?? "idle",
  blockers: status[0]?.blockers ?? [],
  status,
  open: true,
  terminal: { source: "herdr", workspaceID: "w_gen", workspace: "general", title: "Mock session", status: herdrStatus(status[0]?.state ?? "idle") },
})
let pushPrefs: Record<string, boolean> = { ...DEFAULT_PUSH_PREFS, say: false }
let quietHours: { start: string; end: string; timeZone: string } | null = null
let activityMinutes = 5
/** Push subscription endpoints the fake hub holds for this device; tests fake PushManager in the page. */
let pushEndpoints: string[] = []
let mutedSessions: string[] = []
let pushTests = 0
/** Kinds asked for by POST /api/push/test ("" for a basic test). */
let pushTestKinds: string[] = []
let keys: Record<string, string | undefined> = { stt: "sk-or-v1-mock-stt-1234", tts: undefined }
const seedSpeech = () => ({
  stt: { provider: "openrouter", model: "openai/whisper-1", language: "en" as string | undefined, baseURL: undefined as string | undefined },
  tts: { provider: "openai-compatible", model: "tts-1", voice: "alloy", baseURL: "http://kokoro:8880/v1" as string | undefined, speed: undefined as number | undefined },
})
let speech = seedSpeech()
const voiceHints = { "tts-": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"], "gpt-4o-mini-tts": ["alloy", "coral", "sage"], kokoro: ["af_bella", "am_adam"] }
const keyInfo = (kind: "stt" | "tts") => {
  const key = keys[kind]
  if (key) return { set: true, last4: key.slice(-4), source: "settings" }
  return kind === "tts" ? { set: true, last4: "9z9z", source: "env" } : { set: false, source: "none" }
}
const usable = (kind: "stt" | "tts") => (speech[kind].provider === "openrouter" ? keyInfo(kind).set : !!speech[kind].baseURL)
const readiness = (stt: boolean, tts: boolean) => ({
  stt,
  tts,
  ...(stt && tts ? {} : { reason: "Speech-to-text needs an OpenRouter API key. Set it in Settings → Speech." }),
})
/** The server default (GET/PUT /api/settings/speech/default; before 0.3.0 the only scope). */
const speechSettings = () => ({
  stt: { ...speech.stt, apiKey: keyInfo("stt") },
  tts: { ...speech.tts, apiKey: keyInfo("tts") },
  voiceHints,
  ready: readiness(usable("stt"), usable("tts")),
})
type Own = { stt: Record<string, unknown>; tts: Record<string, unknown>; keys: { stt?: string; tts?: string } }
let userSpeech = new Map<string, Own>()
const ownOf = (id: string) => {
  if (!userSpeech.has(id)) userSpeech.set(id, { stt: {}, tts: {}, keys: {} })
  return userSpeech.get(id)!
}
const userKey = (key: string) => ({ set: true, last4: key.slice(-4), source: "user" })
/** GET /api/settings/speech for a user: own field → server default, keys masked, plus scope/default/user. */
function userSpeechSettings(user: MockUser) {
  const own = ownOf(user.id)
  const card = (kind: "stt" | "tts") => {
    const merged: Record<string, unknown> = { ...speech[kind] }
    for (const [k, v] of Object.entries(own[kind])) if (v !== undefined) merged[k] = v
    const key = own.keys[kind]
    return { ...merged, apiKey: key ? userKey(key) : keyInfo(kind) }
  }
  const stt = card("stt")
  const tts = card("tts")
  const ok = (c: Record<string, any>) => (c.provider === "openrouter" ? !!c.apiKey.set : !!c.baseURL)
  const mine = (kind: "stt" | "tts") => ({ ...own[kind], ...(own.keys[kind] ? { apiKey: userKey(own.keys[kind]!) } : {}) })
  const { voiceHints: _, ready: __, ...def } = speechSettings()
  return { stt, tts, voiceHints, ready: readiness(ok(stt), ok(tts)), scope: "user", default: def, user: { stt: mine("stt"), tts: mine("tts") } }
}
/** Applies a speech PUT body to a scope; returns an error response body or undefined. */
function applySpeech(body: Record<string, any>, target: { stt: Record<string, unknown>; tts: Record<string, unknown> }, setKey: (kind: "stt" | "tts", key: string | undefined) => void, dropKey: boolean) {
  for (const kind of ["stt", "tts"] as const) {
    const patch = body[kind]
    if (typeof patch?.baseURL === "string" && !/^https?:\/\//.test(patch.baseURL)) return { error: "baseURL must be an http(s) URL", field: `${kind}.baseURL` }
  }
  for (const kind of ["stt", "tts"] as const) {
    const patch = body[kind]
    if (!patch) continue
    if ("apiKey" in patch) setKey(kind, patch.apiKey ?? undefined)
    else if (dropKey && ("provider" in patch || "baseURL" in patch)) setKey(kind, undefined)
    for (const [k, v] of Object.entries(patch)) {
      if (k === "apiKey") continue
      if (v === null || v === undefined) delete target[kind][k]
      else target[kind][k] = v
    }
  }
  return undefined
}
type Client = { send: (message: object) => void; user: MockUser }
const clients = new Set<Client>()
/** Sends to every SSE client allowed to see the message (session owner; enrollments to admins only). */
const emit = (message: object) => {
  const m = message as { type?: string; sessionID?: string; rootID?: string }
  for (const c of clients) {
    if (m.type === "catalog") c.send(catalog(c.user))
    else if (m.type === "enrollment" && c.user.role !== "admin") continue
    else if (m.type === "prefs" && (m as { userID?: string }).userID !== c.user.id) continue
    else if (m.type === "prefs") c.send({ type: "prefs", prefs: prefsOf(c.user.id) })
    else if (m.sessionID && !canSee(c.user, m.rootID ?? m.sessionID)) continue
    else c.send(message)
  }
}
const emitCatalog = () => emit({ type: "catalog" })

// ---------- users, ownership, auth (multi-user mock) ----------

type MockUser = { id: string; email?: string; name?: string; role: "admin" | "user"; disabled?: boolean; created: number; lastSeen: number }
type MockMachine = { id: string; name: string; ownerID: string; online: boolean; created: number; lastSeen: number }
type MockDevice = { id: string; name: string; ownerID: string; lastSeen: number }
type Audit = { at: number; actor: string; action: string; target?: string; detail?: string }
let authMode: "pairing" | "oidc" = "pairing"
let loginAs = "u_alice"
const DAY = 86_400_000
function seedUsers(): MockUser[] {
  const t = Date.now()
  return [
    { id: "local", role: "admin", created: t - 90 * DAY, lastSeen: t - 2 * DAY },
    { id: "u_alice", email: "alice@example.com", name: "Alice Example", role: "admin", created: t - 30 * DAY, lastSeen: t - 60_000 },
    { id: "u_bob", email: "bob@example.com", name: "Bob Example", role: "user", created: t - 12 * DAY, lastSeen: t - 3 * 3_600_000 },
    { id: "u_carol", email: "carol@example.com", role: "user", disabled: true, created: t - 20 * DAY, lastSeen: t - 9 * DAY },
  ]
}
function seedMachines(): MockMachine[] {
  const t = Date.now()
  return [
    { id: "mac_3", name: "bob-laptop", ownerID: "u_bob", online: true, created: t - 10 * DAY, lastSeen: t },
    { id: "mac_4", name: "carol-desktop", ownerID: "u_carol", online: false, created: t - 19 * DAY, lastSeen: t - 9 * DAY },
  ]
}
function seedDevices(): MockDevice[] {
  const t = Date.now()
  return [
    { id: "dev_alice_pixel", name: "Pixel 9 · Chrome", ownerID: "u_alice", lastSeen: t - 5 * 3_600_000 },
    { id: "dev_bob_iphone", name: "iPhone · Safari", ownerID: "u_bob", lastSeen: t - 3 * 3_600_000 },
    { id: "dev_carol", name: "Android · Chrome", ownerID: "u_carol", lastSeen: t - 9 * DAY },
  ]
}
function seedAudit(): Audit[] {
  const t = Date.now()
  return [
    { at: t - 30 * DAY, actor: "system", action: "migrate.local", target: "u_alice" },
    { at: t - 12 * DAY, actor: "u_bob", action: "signin" },
    { at: t - 10 * DAY, actor: "u_bob", action: "machine.approve", target: "mac_3" },
    { at: t - 9 * DAY, actor: "u_alice", action: "user.disable", target: "u_carol" },
    { at: t - 2 * DAY, actor: "system", action: "signin.denied", detail: "mallory@example.net" },
    { at: t - 3_600_000, actor: "u_alice", action: "speech.default" },
  ]
}
function seedEnrollments() {
  const t = Date.now()
  return [
    { userCode: "WXYZ-2345", machineName: "build-box", created: t - 2 * 60_000 },
    { userCode: "KMNP-6789", machineName: "raspberry-pi", created: t - 7 * 60_000 },
  ]
}
let users = seedUsers()
let extraMachines = seedMachines()
let devices = seedDevices()
/** App link codes (POST /api/devices/link), redeemed by POST /mock/redeem standing in for the native app. */
let linkCodes = new Map<string, { ownerID: string; expiresAt: number }>()
let audit = seedAudit()
let enrollments = seedEnrollments()
/** Owner of the main fixtures (laptop, desktop): the implicit owner in pairing mode, alice in oidc mode. */
const mainOwner = () => (authMode === "oidc" ? "u_alice" : "local")
const userByID = (id: string) => users.find((u) => u.id === id)
const BOB_SESSION = "ses_bob"
const bobSession = (): Fixture => ({ id: BOB_SESSION, title: "Bob's grocery list app", directory: "/home/bob/projects/groceries", project: "/home/bob/projects/groceries", projectName: "groceries", updated: Date.now() - 6 * 60_000, exposed: true, state: "idle", blockers: [] })
/** Whether a user may see a (root) session: bob's laptop reports ses_bob, the main machines report everything else. */
const canSee = (user: MockUser, sessionID: string) => (sessionID === BOB_SESSION ? user.id === "u_bob" : user.id === mainOwner())
const record = (actor: string, action: string, target?: string, detail?: string) => {
  audit.push({ at: Date.now(), actor, action, ...(target ? { target } : {}), ...(detail ? { detail } : {}) })
  if (audit.length > 500) audit.shift()
}
const cookieOf = (request: Request, name: string) =>
  (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1)
/** The signed-in user, or undefined (401). */
function whoami(request: Request): MockUser | undefined {
  const id = cookieOf(request, "mock_user")
  if (id === "out") return undefined
  const user = userByID(id ?? (authMode === "pairing" ? "local" : ""))
  if (!user || user.disabled) return undefined
  if (authMode === "pairing" && user.id !== "local") return undefined
  if (authMode === "oidc" && user.id === "local") return undefined
  user.lastSeen = Date.now()
  return user
}
const signedIn = (id: string, location: string) =>
  new Response(null, { status: 302, headers: { location, "set-cookie": `mock_user=${id}; Path=/; HttpOnly; SameSite=Lax` } })
const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/")
const page = (title: string, text: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/app.css"></head><body><main id="view"><div class="card stack"><h1>${title}</h1><p>${text}</p><p><a class="btn primary" href="/">Back to OpenCode Hub</a></p></div></main></body></html>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
  )
const machinesOf = (user: MockUser) => [
  ...(user.id === mainOwner() ? [{ id: "mac_1", name: "laptop", online: true, lastSeen: Date.now(), created: Date.now() - 40 * DAY }, { id: "mac_2", name: "desktop", online: false, lastSeen: Date.now() - 3 * 3_600_000, created: Date.now() - DAY }] : []),
  ...extraMachines.filter((m) => m.ownerID === user.id),
]

const catalog = (user: MockUser) => ({
  type: "catalog",
  machines: [
    ...extraMachines
      .filter((m) => m.ownerID === user.id)
      .map((m) => ({ ...m, ownerID: undefined, processes: m.id === "mac_3" && m.online ? [{ id: "proc_bob", kind: "service", directory: "/home/bob", pid: 5151, sessions: [catalogSession(bobSession())] }] : [] })),
    ...(user.id === mainOwner() ? mainMachines() : []),
  ],
})

const mainMachines = () => [
    {
      id: "mac_1",
      name: "laptop",
      created: Date.now(),
      lastSeen: Date.now(),
      online: true,
      terminals: herdr.on ? { herdr: { workspaces: HERDR } } : {},
      processes: [
        ...(serviceConnected
          ? [{ id: "proc_1", kind: "service", directory: "/home/user", pid: 4242, opencodeVersion: "2.0.26", sessions: [mockSession(), ...sessions.filter((s) => !s.machine).map(catalogSession)] }]
          : []),
        {
          id: "proc_2",
          kind: "standalone",
          directory: "/tmp/scratch",
          pid: 777,
          sessions: [
            catalogSession({ id: "ses_scratch", title: "Scratch experiment", directory: "/tmp/scratch", updated: Date.now() - 4 * 60_000, exposed: true, state: "idle", blockers: [] }),
            ...sessions.filter((s) => s.id === "ses_05").map(catalogSession),
          ],
        },
        ...(harnessSpokes ? HARNESS_PROCS.map((proc) => ({ ...proc, sessions: sessions.filter((s) => s.proc === proc.id).map(catalogSession) })) : []),
      ],
    },
    { id: "mac_2", name: "desktop", created: Date.now() - 86_400_000, lastSeen: Date.now() - 3 * 3_600_000, online: false, processes: [] },
    ...(workstation
      ? [
          {
            id: "mac_5",
            name: "workstation",
            created: Date.now() - 5 * 86_400_000,
            lastSeen: Date.now(),
            online: true,
            processes: [
              {
                id: "proc_ws",
                kind: "service",
                directory: "/home/user",
                pid: 5050,
                opencodeVersion: "2.0.25",
                sessions: [
                  catalogSession({ id: "ses_ws_1", title: "Train the ranking model", directory: WORKSTATION_DIR, projectName: "ml-lab", project: WORKSTATION_DIR, updated: Date.now() - 3_600_000, exposed: true, state: "idle", blockers: [] }),
                  ...sessions.filter((s) => s.machine === "mac_5").map(catalogSession),
                ],
              },
            ],
          },
        ]
      : []),
]

/** A WAV tone (~55 ms per character, 0.4–4 s) standing in for TTS audio. */
function toneWav(text: string): Uint8Array<ArrayBuffer> {
  const rate = 16_000
  const seconds = Math.min(4, Math.max(0.4, text.length * 0.055))
  const n = Math.round(rate * seconds)
  const bytes = new Uint8Array(44 + n * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 3000), true)
  return bytes
}

function sse(request: Request, user: MockUser): Response {
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
        } catch {
          cleanup()
        }
      }
      const client = { send, user }
      send(catalog(user))
      clients.add(client)
      // Like the hub: a named heartbeat every 20 s (the console reopens a stream silent for 45 s).
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("event: ping\ndata: 0\n\n"))
        } catch {
          cleanup()
        }
      }, 20_000)
      cleanup = () => {
        clearInterval(heartbeat)
        clients.delete(client)
      }
      request.signal.addEventListener("abort", () => cleanup(), { once: true })
    },
    cancel: () => cleanup(),
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** When streamed root texts ended (`{messageID, at}`), for checks that speech starts before the text ends. */
const textEnded: Array<{ messageID: string; at: number }> = []

/**
 * Emits text in small chunks as SSE delta (text) or reasoning messages, like the hub after coalescing. Root text
 * in conversation mode is also spoken like the hub does it: a say per completed sentence (SentenceStream), the
 * rest when the text ends.
 */
async function streamText(kind: "text" | "reasoning", sessionID: string, messageID: string, text: string, every = 100, size = 7, alive = () => true) {
  const speech = kind === "text" && sessionID === SESSION ? new SentenceStream() : undefined
  let seq = 0
  const say = (sentences: string[]) => {
    if (conversation) for (const s of sentences) emit({ type: "say", sessionID, messageID, ordinal: 0, seq: seq++, text: s })
  }
  for (let i = 0; i < text.length && alive(); i += size) {
    const chunk = text.slice(i, i + size)
    emit(kind === "text" ? { type: "delta", sessionID, rootID: SESSION, messageID, text: chunk } : { type: "reasoning", sessionID, rootID: SESSION, messageID, delta: chunk })
    if (speech) say(speech.push(chunk))
    await sleep(every)
  }
  if (speech && alive()) {
    textEnded.push({ messageID, at: Date.now() })
    say(speech.end(text))
  }
}

function setStatus(next: Status[]) {
  status = next
  emit({ type: "status", sessionID: SESSION, sessions: status })
}

function addActivity(sessionID: string, item: Record<string, unknown>) {
  const full: Record<string, unknown> = { ...item, sessionID, at: Date.now() }
  const i = activity.findIndex((x) => x.id === full.id)
  if (i >= 0) activity[i] = full
  else activity.push(full)
  if (activity.length > 30) activity.shift()
  emit({ type: "activity", sessionID, rootID: SESSION, item: full })
}

let scenarioRun = 0
/** A scripted run of ses_mock: root reasoning → tool → two subagents streaming → reply text (+ say) → idle. */
async function scenario() {
  const run = ++scenarioRun
  const alive = () => run === scenarioRun
  const t0 = Date.now()
  const root = (state: string): Status => ({ id: SESSION, title: "Mock session", state, blockers: [], ...(state === "working" ? { since: t0 } : {}) })
  const kid = (id: string, title: string, state: string, since: number): Status => ({ id, parentID: SESSION, title, state, blockers: [], ...(state === "working" ? { since } : {}) })
  setStatus([root("working")])
  await sleep(600)
  await streamText("reasoning", SESSION, "msg_r1", "The user wants the failing tests fixed.\nFirst I should look at the test output to see what broke.\nThe picker tests and the pulse tests are new, so check those.\nThen hand the fix to a subagent so we can keep talking.\nLet me run the suite first.", 90, 9, alive)
  if (!alive()) return
  addActivity(SESSION, { id: "thinking:msg_r1", kind: "thinking", state: "done" })
  addActivity(SESSION, { id: "tool_bash", kind: "tool", tool: "bash", summary: "bun test", state: "running" })
  await sleep(2500)
  if (!alive()) return
  addActivity(SESSION, { id: "tool_bash", kind: "tool", tool: "bash", summary: "bun test", state: "done" })
  addActivity(SESSION, { id: "tool_task", kind: "tool", tool: "task", summary: "Fix failing tests", background: true, state: "running" })
  const k1 = Date.now()
  setStatus([root("working"), kid("ses_mock_kid", "Fix failing tests", "working", k1)])
  const kidWork = (async () => {
    await streamText("reasoning", "ses_mock_kid", "msg_k1", "Two failures in web-picker.test.ts.\nThe ranking puts prefix matches after the rest.", 90, 8, alive)
    addActivity("ses_mock_kid", { id: "tool_k_read", kind: "tool", tool: "read", summary: "web/picker-core.js", state: "running" })
    await sleep(700)
    addActivity("ses_mock_kid", { id: "tool_k_read", kind: "tool", tool: "read", summary: "web/picker-core.js", state: "done" })
    await streamText("text", "ses_mock_kid", "msg_k2", "Reading the failing assertions.\nFixing rank order in filterPicker.\nRe-running bun test test/web-picker.test.ts\n8 pass, 0 fail.", 110, 6, alive)
  })()
  await sleep(1200)
  if (!alive()) return
  const k2 = Date.now()
  setStatus([root("working"), kid("ses_mock_kid", "Fix failing tests", "working", k1), kid("ses_mock_kid2", "Update README", "working", k2)])
  const kid2Work = streamText("text", "ses_mock_kid2", "msg_k3", "Adding the picker to the Speech settings section.\nDocumenting reasoning SSE.", 140, 6, alive)
  const reply1 = "I started two subagents: one fixes the failing tests, the other updates the README. I'll tell you when they're done."
  await streamText("text", SESSION, "msg_t1", reply1, 80, 8, alive)
  await kid2Work
  if (!alive()) return
  setStatus([root("working"), kid("ses_mock_kid", "Fix failing tests", "working", k1), kid("ses_mock_kid2", "Update README", "idle", k2)])
  await kidWork
  if (!alive()) return
  setStatus([root("working"), kid("ses_mock_kid", "Fix failing tests", "idle", k1), kid("ses_mock_kid2", "Update README", "idle", k2)])
  addActivity(SESSION, { id: "tool_task", kind: "tool", tool: "task", summary: "Fix failing tests", background: true, state: "done" })
  const reply2 = "All done: the tests pass and the README is updated."
  await streamText("text", SESSION, "msg_t2", reply2, 80, 8, alive)
  await sleep(300)
  if (!alive()) return
  setStatus([root("idle"), kid("ses_mock_kid", "Fix failing tests", "idle", k1), kid("ses_mock_kid2", "Update README", "idle", k2)])
}

// ---------- console (0.5): timeline, models, summary/diff, reads, stop, Send/Steer ----------

let reads: Record<string, Record<string, number>> = {}
let modelPrefs: Record<string, { voice?: unknown; worker?: unknown }> = {}
/** A realistic catalog: a gateway provider with hundreds of aliased models, native providers, effort variants. */
const MODELS = (() => {
  const efforts = ["low", "medium", "high"]
  const list: Array<{ providerID: string; modelID: string; name: string; enabled: boolean; status: string; variants: string[] }> = [
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", enabled: true, status: "active", variants: ["default", "high", "max"] },
    { providerID: "anthropic", modelID: "claude-haiku-4-5", name: "Claude Haiku 4.5", enabled: true, status: "active", variants: [] },
    { providerID: "anthropic", modelID: "claude-opus-4-1", name: "Claude Opus 4.1", enabled: true, status: "active", variants: ["default", "high"] },
    { providerID: "anthropic", modelID: "claude-3-haiku", name: "Claude 3 Haiku", enabled: false, status: "deprecated", variants: [] },
    { providerID: "openai", modelID: "gpt-5", name: "GPT-5", enabled: true, status: "active", variants: efforts },
    { providerID: "openai", modelID: "gpt-5-mini", name: "GPT-5 mini", enabled: true, status: "active", variants: efforts },
    { providerID: "openai", modelID: "gpt-4.1", name: "GPT-4.1", enabled: true, status: "active", variants: [] },
    { providerID: "openrouter", modelID: "qwen/qwen3-coder", name: "Qwen3 Coder", enabled: true, status: "active", variants: [] },
    { providerID: "google", modelID: "gemini-2.5-pro", name: "Gemini 2.5 Pro", enabled: true, status: "active", variants: ["low", "high"] },
    { providerID: "google", modelID: "gemini-2.5-flash", name: "Gemini 2.5 Flash", enabled: true, status: "active", variants: [] },
  ]
  const vendors = ["anthropic", "openai", "google", "meta-llama", "mistralai", "qwen", "deepseek", "moonshotai", "x-ai", "z-ai"]
  for (let i = 0; i < 40; i++) {
    const vendor = vendors[i % vendors.length]!
    list.push({ providerID: "openrouter", modelID: `${vendor}/model-${i + 1}`, name: `${vendor}: Model ${i + 1}`, enabled: true, status: i % 13 === 0 ? "beta" : "active", variants: i % 4 === 0 ? efforts : [] })
  }
  // The gateway: OpenCode ids are short aliases ("claude-opus-5-5"); the upstream modelID is not shown.
  for (const [id, name, variants] of [
    ["claude-opus-5-5", "Claude Opus 5.5", ["high", "max"]],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5", ["high", "max"]],
    ["claude-haiku-5-5", "Claude Haiku 5.5", []],
    ["gpt-6-sol", "GPT-6 Sol", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["kimi-k3", "Kimi K3", []],
  ] as const) list.push({ providerID: "omniroute", modelID: id, name, enabled: true, status: "active", variants: [...variants] })
  for (let i = 0; i < 180; i++) {
    const vendor = vendors[(i * 3) % vendors.length]!
    list.push({ providerID: "omniroute", modelID: `${vendor}/gw-${String(i + 1).padStart(3, "0")}`, name: `${vendor} gateway model ${i + 1}`, enabled: true, status: "active", variants: i % 9 === 0 ? efforts : [] })
  }
  return list
})()
const MODEL_DEFAULTS = { voice: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, worker: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" } }
const CHANGES = [
  { file: "web/src/app/Session.tsx", status: "modified", additions: 42, deletions: 7 },
  { file: "web/src/lib/composer.ts", status: "added", additions: 88, deletions: 0 },
  { file: "web/old-app.js", status: "deleted", additions: 0, deletions: 120 },
]
const PATCH = [
  "diff --git a/web/src/app/Session.tsx b/web/src/app/Session.tsx",
  "--- a/web/src/app/Session.tsx",
  "+++ b/web/src/app/Session.tsx",
  "@@ -10,6 +10,9 @@ export function SessionView(props: { id: string }) {",
  "   const found = () => lookup(id)",
  "-  const running = () => false",
  "+  const running = () => treeRunning(status())",
  "+  const offline = () => !found()",
  "+  const exposed = () => found()?.session.exposed !== false",
  "   // ---------- timeline ----------",
  "   const timeline = new Timeline()",
].join("\n")

/** A reply using everything the console renders (session "Benchmark harness"; e2e and screenshots). */
export const RICH_MARKDOWN = [
  "## Benchmark results",
  "",
  "Ran the harness on **3 engines**; ==pgvector is fastest== below 1M rows. ~~FAISS on CPU~~ was dropped.",
  "Raw data: https://example.com/bench/run-42 (CSV).",
  "",
  "| Engine | p50 (ms) | p99 (ms) | Recall@10 |",
  "|:-------|---------:|---------:|:---------:|",
  "| pgvector | 4.1 | 11.8 | 0.97 |",
  "| Qdrant | 5.3 | 14.2 | **0.98** |",
  "| `sqlite-vec` | 9.7 | 31.0 | 0.95 |",
  "",
  "### Next steps",
  "",
  "1. Tune the index",
  "   - `lists = 100` for pgvector",
  "   - [ ] try HNSW",
  "   - [x] warm the cache",
  "2. Re-run with 10M rows",
  "",
  "> **Note:** numbers are from one machine.",
  "> - noisy neighbours possible",
  "",
  "```ts",
  "// Run one query and time it",
  "export async function timeQuery(db: Db, vector: number[]): Promise<number> {",
  "  const t0 = performance.now()",
  '  await db.query("SELECT id FROM items ORDER BY embedding <-> $1 LIMIT 10", [vector])',
  "  return performance.now() - t0",
  "}",
  "```",
  "",
  "```diff",
  "-const LISTS = 50",
  "+const LISTS = 100",
  "```",
].join("\n")

/** History of a session: a user request, reasoning, a run of tools (one failed), a reply, a subagent. */
function timelineOf(id: string, title: string) {
  const t0 = Date.now() - 20 * 60_000
  const m = (n: number) => `msg_${id}_${n}`
  return [
    { key: `${m(1)}:text`, messageID: m(1), sessionID: id, kind: "user", text: `Please look at “${title || "this"}” and fix what's broken.`, at: t0, ...(id === SESSION ? { files: [{ index: 0, mime: "image/png", name: "screenshot.png" }] } : {}) },
    { key: `${m(2)}:0`, messageID: m(2), partID: "0", sessionID: id, kind: "reasoning", text: "The failing test is in the picker. Read it first, then run the suite.", state: "done", at: t0 + 1000, completed: t0 + 13_400 },
    { key: `${m(2)}:1`, messageID: m(2), partID: "1", sessionID: id, kind: "tool", name: "read", state: "done", at: t0 + 14_000, completed: t0 + 14_200 },
    { key: `${m(2)}:2`, messageID: m(2), partID: "2", sessionID: id, kind: "tool", name: "bash", state: "failed", at: t0 + 15_000, completed: t0 + 21_000 },
    { key: `${m(2)}:3`, messageID: m(2), partID: "3", sessionID: id, kind: "tool", name: "edit", state: "done", at: t0 + 22_000, completed: t0 + 22_500 },
    { key: `${m(2)}:4`, messageID: m(2), partID: "4", sessionID: id, kind: "assistant", text: "I fixed the ranking in **filterPicker** and re-ran the suite:\n\n- `bun test test/web-picker.test.ts` → 8 pass\n- no other failures\n\n```ts\nranked.sort((a, b) => a.rank - b.rank || a.index - b.index)\n```\nAnything else?", at: t0 + 30_000 },
    ...(title === "Benchmark harness" ? [{ key: `${m(2)}:5`, messageID: m(2), partID: "5", sessionID: id, kind: "assistant", text: RICH_MARKDOWN, at: t0 + 30_500 }] : []),
    // Claude-style reasoning: only an encrypted signature is stored, no readable text.
    { key: `${m(3)}:0`, messageID: m(3), partID: "0", sessionID: id, kind: "reasoning", text: "", state: "done", at: t0 + 31_000, completed: t0 + 33_000 },
    ...(id === SESSION ? hubMessageRows(id, t0) : []),
  ]
}

/**
 * ses_mock's hub messages: the identity primer and a message from @web-work in its history (the spoke's rows of
 * the synthetic messages), and one it sent to @@reviewer (GET …/messages, the hub's store).
 */
function hubMessageRows(id: string, t0: number) {
  const synthetic = (n: number, messageID: string, text: string, kind: string, from: string, to: string) => ({
    id: `msg_${id}_hub${n}`,
    type: "synthetic",
    time: { created: t0 + 31_100 + n * 100 },
    metadata: { source: "hub", messageID, kind, from, to },
    text,
  })
  return timelineItems(id, [
    synthetic(1, "hm_primer", "[hub] You are @mock. Message others with `hub msg @name`; see `hub who`.", "primer", "hub", "@mock"),
    synthetic(2, "hm_in1", "[hub] msg from @web-work to you · 10-24 12:00Z · hm_in1\n----- hm_in1 -----\nThe API types changed; please rebase.\n----- hm_in1 -----\n↩ hub reply hm_in1 \"…\"", "msg", "@web-work", "@mock"),
  ]) as unknown as Array<Record<string, unknown>>
}
const sentMessages = () => [
  {
    id: "hm_out1",
    kind: "ask",
    from: { kind: "session", sessionID: SESSION, name: "mock" },
    to: "@@reviewer",
    recipient: { kind: "session", sessionID: "ses_rev", name: "rev" },
    text: "Can you review the picker fix?",
    state: "open",
    at: Date.now() - 20 * 60_000 + 31_500,
    hop: 0,
  },
]

/** The long history of ses_big (POST /mock/big). */
const BIG = "ses_big"
let big = { on: false, messages: 900, delayMs: 0, failOlder: false, rows: [] as Array<Record<string, unknown>> }
function bigRows(from: number, count: number) {
  const t0 = Date.now() - 30 * 86_400_000
  const out: Array<Record<string, unknown>> = []
  for (let i = from; i < from + count; i++) {
    const id = `msg_big_${i}`
    const at = t0 + i * 60_000
    if (i % 2 === 0) out.push({ key: `${id}:text`, messageID: id, sessionID: BIG, kind: "user", text: `Question ${i}: what about step ${i}?`, at })
    else {
      if (i % 6 === 1) out.push({ key: `${id}:0`, messageID: id, partID: "0", sessionID: BIG, kind: "tool", name: "bash", state: "done", at, completed: at + 2000 })
      out.push({ key: `${id}:1`, messageID: id, partID: "1", sessionID: BIG, kind: "assistant", text: `Answer ${i}.\n\nStep ${i} is done; the next one follows.`, at: at + 3000 })
    }
  }
  return out
}
const bigFixture = (): Fixture => ({ id: BIG, title: "Long history", directory: "/home/user/research", project: "/home/user/research", projectName: "research", updated: Date.now() - 60 * 60_000, exposed: true, state: "idle", blockers: [] })

/** "Subagent order" (POST /mock/order): a trimmed real session that spawned subagents over several turns. */
const ORDER = "ses_order"
type OrderMessage = { id: string; type: string; content?: Array<Record<string, any>> }
const ORDER_CONTEXT = orderSession as unknown as OrderMessage[]
/** Messages of the live turn: msg_046 (reasoning, text, shell), msg_047 (two subagents), msg_048 (text). */
const ORDER_LIVE = [45, 48] as const
let order = { messages: ORDER_LIVE[0] as number, run: 0 }

// ---------- decisions (hub ask @me) ----------
let mockDecisions: Array<Record<string, any>> = []

// ---------- agents (grants, switches, the agent audit) ----------
type MockGrant = Record<string, any> & { id: string; holder: string; created: number; expiresAt: number; revokedAt?: number }
let grants: MockGrant[] = []
let grantSeq = 0
let actingPaused = false
let hubActingPaused = false
let agentAudit: Array<Record<string, any>> = []
const agentError = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
const grantState = (g: MockGrant) => (g.revokedAt !== undefined ? "revoked" : Date.now() >= g.expiresAt ? "expired" : "active")
const grantView = (g: MockGrant) => ({ ...g, state: grantState(g) })
const DURATION_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const VERBS = ["approve", "deny", "answer", "prompt", "stop", "roles", "launch"]
/** The hub's grant validation, roughly (src/central/agent/policy.ts validateGrant): a Response when invalid. */
function grantSpec(body: Record<string, any>): Response | Record<string, any> {
  const holder = body.holder
  if (typeof holder !== "string" || !/^(@@(orchestrator|concierge)[\w.-]*|@[a-z0-9][\w-]*|ses_\w+|app:[0-9a-f]{16})$/.test(holder)) {
    return agentError(400, "invalid", "holder is @@role, @name, ses_… or app:<token id>")
  }
  if (holder === "@ghost") return agentError(404, "not_found", "No session named @ghost")
  const projects = body.scope?.projects
  if (!Array.isArray(projects) || !projects.length) return agentError(400, "invalid", "scope.projects lists 1–20 project directories")
  const bad = projects.find((x: unknown) => typeof x !== "string" || !x.startsWith("/"))
  if (bad !== undefined) return agentError(400, "invalid", `scope.projects: ${bad} is not an absolute project directory`)
  if (!Array.isArray(body.allow) || !body.allow.length) return agentError(400, "invalid", `allow lists the verbs: ${VERBS.join(", ")}`)
  const verb = body.allow.find((v: unknown) => !VERBS.includes(v as string))
  if (verb !== undefined) return agentError(400, "invalid", `allow: unknown verb ${verb}`)
  const never = body.permissions?.never ?? []
  const nonsense = never.find((x: string) => /\s$|^\s|^:/.test(x))
  if (nonsense !== undefined) return agentError(400, "invalid", `permissions.never: ${nonsense} is not an action[:glob] pattern`)
  const match = /^(\d+)(s|m|h|d)?$/.exec(String(body.expires ?? "8h"))
  const ms = match ? Number(match[1]) * DURATION_MS[match[2] ?? "s"]! : NaN
  if (!(ms >= 60_000 && ms <= 30 * 86_400_000)) return agentError(400, "invalid", "expires is 1 minute to 30 days (seconds, or 30m, 8h, 2d)")
  const cap = body.maxActionsPerHour ?? 60
  if (!Number.isInteger(cap) || cap < 1 || cap > 1000) return agentError(400, "invalid", "maxActionsPerHour is a whole number 1–1000")
  return {
    holder,
    scope: { projects: [...projects] },
    allow: [...body.allow],
    permissions: { allow: [...(body.permissions?.allow ?? [])], never: [...never] },
    allowAlways: body.allowAlways === true,
    maxActionsPerHour: cap,
    expiresAt: Date.now() + ms,
  }
}
function recordAgent(patch: Record<string, any>): Record<string, any> {
  const seq = (agentAudit[agentAudit.length - 1]?.seq ?? 0) + 1
  const entry = {
    seq,
    at: Date.now(),
    actor: { kind: "session", sessionID: "ses_orch", name: "orchestrator" },
    verb: "approve",
    target: { sessionID: SESSION, requestID: "per_1" },
    grant: "g_mock",
    decision: "allow",
    outcome: "ok",
    ...patch,
  }
  for (const key of Object.keys(entry)) if ((entry as Record<string, unknown>)[key] === null) delete (entry as Record<string, unknown>)[key]
  agentAudit.push(entry)
  return entry
}
let decisionSeq = 0
function mockDecision(body: Record<string, any>): Record<string, any> {
  const { silent: _silent, ...patch } = body
  const existing = typeof patch.id === "string" ? mockDecisions.find((d) => d.id === patch.id) : undefined
  if (existing) {
    Object.assign(existing, patch)
    return existing
  }
  const at = Date.now()
  const decision = {
    id: `dec_mock${++decisionSeq}`,
    messageID: `msg_mockdec${decisionSeq}`,
    from: { kind: "session", sessionID: SESSION, name: "mock" },
    about: [SESSION],
    sessionID: SESSION,
    question: "Drop column legacy_id?",
    options: [
      { id: "go", label: "Proceed" },
      { id: "hold", label: "Hold", safe: true },
    ],
    recommendation: { option: "hold", why: "3 services still read legacy_id" },
    urgency: "normal",
    tier: "confirm",
    state: "open",
    at,
    expiresAt: at + 86_400_000,
    ...patch,
  }
  mockDecisions.push(decision)
  return decision
}
const orderRows = () => timelineItems(ORDER, ORDER_CONTEXT.slice(0, order.messages)) as unknown as Array<Record<string, unknown>>
function orderTree(working: readonly string[] = []): Status[] {
  const spawned = orderRows().filter((r) => typeof r.childSessionID === "string")
  const live = ORDER_CONTEXT.slice(order.messages, ORDER_LIVE[1]).flatMap((m) => (m.content ?? []).filter((p) => working.includes(p.state?.metadata?.sessionID)))
  return [
    { id: ORDER, title: "Subagent order", state: working.length ? "working" : "idle", blockers: [] },
    ...spawned.map((r) => ({ id: r.childSessionID as string, parentID: ORDER, title: r.title as string, state: "idle", blockers: [] })),
    ...live.map((p) => ({ id: p.state.metadata.sessionID as string, parentID: ORDER, title: p.state.input.description as string, state: "working", blockers: [], since: Date.now() })),
  ]
}
const orderFixture = (): Fixture => ({ id: ORDER, title: "Subagent order", directory: "/home/user/research", project: "/home/user/research", projectName: "research", updated: Date.now() - 5 * 60_000, exposed: true, state: "idle", blockers: [], tree: orderTree() })
function setOrderTree(tree: Status[]) {
  const fixture = sessions.find((x) => x.id === ORDER)
  if (fixture) Object.assign(fixture, { tree, state: tree[0]!.state })
  emit({ type: "status", sessionID: ORDER, sessions: tree })
}
/** Plays the live turn of "Subagent order" as the hub's SSE events, then adds it to the history. */
async function orderLive() {
  const run = ++order.run
  const [from, to] = ORDER_LIVE
  const working: string[] = []
  const event = (message: object) => run === order.run && emit({ sessionID: ORDER, rootID: ORDER, ...message })
  setOrderTree(orderTree())
  for (const message of ORDER_CONTEXT.slice(from, to)) {
    let texts = 0
    for (const part of message.content ?? []) {
      await sleep(120)
      if (part.type === "reasoning") event({ type: "reasoning", messageID: message.id, delta: "Checking what is left to do." })
      if (part.type === "text") event({ type: "delta", messageID: message.id, ordinal: texts++, text: part.text })
      if (part.type !== "tool") continue
      const item = { id: part.id, sessionID: ORDER, kind: "tool", tool: part.name, state: "running", at: Date.now() }
      event({ type: "activity", item })
      const child = part.state?.metadata?.sessionID as string | undefined
      if (child) {
        event({ type: "activity", item: { ...item, childSessionID: child } })
        working.push(child)
        setOrderTree(orderTree(working))
      }
      await sleep(120)
      event({ type: "activity", item: { ...item, ...(child ? { childSessionID: child } : {}), state: "done", at: Date.now() } })
    }
  }
  await sleep(400)
  if (run !== order.run) return
  // The subagents finish; the turn is stored.
  order.messages = to
  setOrderTree(orderTree())
}

/** A timeline answer like the spoke's: newest-first pages (order=desc, before) or forward pages (cursor). */
async function timelinePage(rows: ReadonlyArray<Record<string, unknown>>, url: URL, older = { delayMs: 0, fail: false }): Promise<Response> {
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const before = url.searchParams.get("before") || undefined
  if (before || url.searchParams.get("order") === "desc") {
    if (before && older.delayMs) await sleep(older.delayMs)
    if (before && older.fail) return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
    try {
      return Response.json(newestPage(rows as never, limit, before))
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 })
    }
  }
  const offset = Number(url.searchParams.get("cursor") ?? 0)
  const items = rows.slice(offset, offset + limit)
  return Response.json({ items, ...(offset + items.length < rows.length ? { cursor: String(offset + items.length) } : {}) })
}

function treeState(id: string): string {
  if (id === SESSION) return status.some((x) => x.state === "blocked") ? "blocked" : status.some((x) => x.state === "working") ? "working" : "idle"
  return sessions.find((x) => x.id === id)?.state ?? "idle"
}

let turnRun = 0
let holdTurns = false
/** POST /mock/slow-turns {ms}: how long a ses_mock turn works before replying (default 2.5 s). */
let slowTurnMs: number | undefined
/** As the hub's TURN_ACCEPT_MS: a respond-async turn still running after this is answered 202. */
const TURN_ACCEPT_MS = 1500
/** Ends the held turn's wait (stop, or the hold lifted). */
let releaseTurn: (() => void) | undefined
/** A typed turn on ses_mock: working → streamed reply → idle (the POST answers when the turn ends). */
async function mockTurn(text: string): Promise<Record<string, unknown>> {
  const run = ++turnRun
  const since = Date.now()
  setStatus([{ id: SESSION, title: "Mock session", state: "working", blockers: [], since }])
  addActivity(SESSION, { id: `tool_turn_${run}`, kind: "tool", tool: "bash", summary: "bun test", state: "running" })
  if (holdTurns) await new Promise<void>((resolve) => (releaseTurn = resolve))
  else await sleep(slowTurnMs ?? 2500)
  addActivity(SESSION, { id: `tool_turn_${run}`, kind: "tool", tool: "bash", summary: "bun test", state: "done" })
  const reply = `Done: ${text}`
  await streamText("text", SESSION, `msg_turn_${run}`, reply, 60, 6, () => run === turnRun)
  if (run !== turnRun) return { outcome: "interrupted", message: "Stopped", reply: "" }
  setStatus([{ id: SESSION, title: "Mock session", state: "idle", blockers: [] }])
  return { outcome: "succeeded", reply }
}

/** A 1×1 PNG served for message images. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/** The hub's image checks, roughly: at most 4, known types, base64 data. */
function imagesProblem(images: unknown): string | undefined {
  if (images === undefined) return undefined
  if (!Array.isArray(images)) return "images must be an array"
  if (images.length > 4) return "Attach at most 4 images"
  for (const image of images) {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image?.mime)) return "Unsupported image type"
    if (typeof image.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return "Image data must be base64"
  }
  return images.reduce((sum: number, i: any) => sum + i.data.length, 0) > 750_000 ? "Images together are too large" : undefined
}

async function consoleRoute(request: Request, url: URL, user: MockUser): Promise<Response | undefined> {
  const p = url.pathname
  const m = request.method
  if (p === "/api/reads" && m === "GET") return Response.json({ reads: reads[user.id] ?? {} })
  const match = /^\/api\/sessions\/([^/]+)\/(timeline|messages|model-prefs|models|summary|diff|read|stop|turn|permission|form)(?:\/messages\/([^/]+)\/(?:parts\/([^/]+)|files\/(\d+)))?$/.exec(p)
  if (!match) return undefined
  const id = decodeURIComponent(match[1]!)
  const child = status.find((x) => x.id === id && x.parentID)
  const fixture = id === SESSION ? { title: "Mock session", directory: `${HOME}/opencode-voice` } : child ? { title: child.title, directory: `${HOME}/opencode-voice` } : id === BOB_SESSION ? bobSession() : sessions.find((x) => x.id === id) ?? (id === "ses_scratch" ? { title: "Scratch experiment", directory: "/tmp/scratch" } : undefined)
  if (!fixture) return Response.json({ error: "Not found" }, { status: 404 })
  const body = async () => (await request.json().catch(() => ({}))) as Record<string, any>
  // A non-OpenCode session's spoke serves only what it announced: the hub's 409 code unsupported otherwise.
  const proc = HARNESS_PROCS.find((x) => x.id === (fixture as Partial<Fixture>).proc)
  const feature = proc && routeFeature(match[2]!, id)
  if (proc && feature && (!proc.features.includes(feature) || forcedUnsupported.has(feature))) {
    return Response.json({ error: `The ${proc.harness} spoke does not support ${feature}`, code: "unsupported" }, { status: 409 })
  }
  switch (match[2]) {
    case "timeline":
      if (match[5] !== undefined) {
        if (match[5] !== "0") return Response.json({ error: "No such image" }, { status: 404 })
        return new Response(Buffer.from(PIXEL_PNG, "base64"), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } })
      }
      if (match[3]) return Response.json({ detail: { name: "bash", state: { status: "error", input: { command: "bun test" }, error: "1 test failed" }, time: { start: Date.now() - 60_000, end: Date.now() - 54_000 } } })
      if (id === BIG) return timelinePage(big.rows, url, { delayMs: big.delayMs, fail: big.failOlder })
      if (id === ORDER) return timelinePage(orderRows(), url)
      return timelinePage(timelineOf(id, fixture.title), url)
    case "messages":
      return Response.json({ messages: id === SESSION ? sentMessages() : [] })
    case "model-prefs":
      if (m === "PUT") {
        const change = await body()
        log[log.length - 1]!.body = change
        if (fail.modelPrefs) return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
        modelPrefs[id] = { ...(modelPrefs[id] ?? {}), ...change }
        for (const key of ["voice", "worker"] as const) if (modelPrefs[id]![key] === null) delete modelPrefs[id]![key]
      }
      return Response.json({ prefs: modelPrefs[id] ?? {}, defaults: MODEL_DEFAULTS })
    case "models":
      if (fail.models) return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
      return Response.json({ models: MODELS })
    case "summary":
      return Response.json({
        directory: fixture.directory,
        branch: id === SESSION ? "feature/remote-session-console" : "main",
        context: { used: 61_200, limit: 200_000, percent: 31, model: "Claude Sonnet 4.5" },
        mcp: [{ name: "brain", status: "connected" }, { name: "github", status: "needs_auth" }, { name: "chrome", status: "failed", error: "spawn ENOENT" }],
        ...(id === SESSION
          ? { changes: { files: CHANGES, additions: 141, deletions: 130, totalFiles: CHANGES.length + 2, truncated: true } }
          : { changes: { files: [], additions: 0, deletions: 0, totalFiles: 0, truncated: false } }),
      })
    case "diff": {
      const file = url.searchParams.get("file")
      const c = CHANGES.find((x) => x.file === file)
      if (!c || id !== SESSION) return Response.json({ error: "No changes for that file" }, { status: 404 })
      return Response.json({ ...c, patch: c.file.endsWith("Session.tsx") ? PATCH : "@@ -0,0 +1,2 @@\n+// new file\n+export {}", truncated: false })
    }
    case "read": {
      reads[user.id] = { ...(reads[user.id] ?? {}), [id]: Date.now() }
      return Response.json({ reads: reads[user.id] })
    }
    case "stop": {
      const running = treeState(id) !== "idle"
      if (id === SESSION) {
        turnRun++
        setStatus([{ id: SESSION, title: "Mock session", state: "idle", blockers: [] }])
        releaseTurn?.()
        releaseTurn = undefined
      }
      return Response.json({ stopped: running ? [id] : [] })
    }
    case "permission": {
      const { requestID } = await body()
      const s = sessions.find((x) => x.id === id)
      if (s) {
        s.blockers = s.blockers.filter((b) => b.id !== requestID)
        if (!s.blockers.length && s.state === "blocked") s.state = "working"
        emitCatalog()
      }
      return new Response(null, { status: 204 })
    }
    case "form": {
      const input = await body()
      log[log.length - 1]!.body = input
      const s = sessions.find((x) => x.id === id)
      if (!s?.blockers.some((b) => b.id === input.formID)) return Response.json({ error: "This request was already answered or expired", code: "gone" }, { status: 409 })
      s.blockers = s.blockers.filter((b) => b.id !== input.formID)
      if (!s.blockers.length && s.state === "blocked") s.state = "working"
      emitCatalog()
      return new Response(null, { status: 204 })
    }
    case "turn": {
      const { text, images } = await body()
      const problem = imagesProblem(images)
      if (problem) return Response.json({ error: problem }, { status: 400 })
      if (typeof text !== "string" || (!text.trim() && !images?.length)) return Response.json({ error: "Empty prompt" }, { status: 400 })
      log[log.length - 1]!.body = { text, ...(images?.length ? { images: images.map((i: any) => ({ mime: i.mime, name: i.name, length: i.data.length })) } : {}) }
      if (text.includes("fail")) return Response.json({ error: "No OpenCode process for this session is connected" }, { status: 409 })
      if (treeState(id) !== "idle") return Response.json({ mode: "steer", inboxID: `inb_${++inbox}` }, { status: 202 })
      // A preset pastes the prompt into the terminal: the hub accepts it, nothing ever confirms the turn.
      if (proc) return Response.json({ mode: "turn" }, { status: 202 })
      if (id === SESSION) {
        const turn = mockTurn(text)
        if (!/respond-async/i.test(request.headers.get("prefer") ?? "")) return Response.json(await turn)
        // As the hub: a quick result is answered as usual; a running turn is 202 and its result an SSE `turn` event.
        const early = await Promise.race([turn, sleep(TURN_ACCEPT_MS).then(() => undefined)])
        if (early) return Response.json(early)
        void turn.then((result) => emit({ type: "turn", sessionID: SESSION, ...result }))
        return Response.json({ mode: "turn" }, { status: 202, headers: { "preference-applied": "respond-async" } })
      }
      return Response.json({ outcome: "succeeded", reply: `You said: ${text}` })
    }
  }
  return undefined
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const p = url.pathname
    const m = request.method
    const json = async () => (await request.json().catch(() => ({}))) as Record<string, any>
    let match0: RegExpExecArray | null
    // This request's own log entry (concurrent requests must not record into each other's).
    const entry: (typeof log)[number] | undefined =
      p.startsWith("/api/") && p !== "/api/events" ? { at: Date.now(), method: m, path: p, ...(url.search ? { query: url.search } : {}), contentType: request.headers.get("content-type") ?? undefined } : undefined
    if (entry) log.push(entry)
    const last = () => entry ?? log[log.length - 1]!

    if (p === "/mock/reset-transcripts" && m === "POST") {
      transcripts = []
      return Response.json({ queued: 0 })
    }
    if (p === "/mock/transcripts" && m === "POST") {
      transcripts.push(...((await json()).texts ?? []))
      return Response.json({ queued: transcripts.length })
    }
    if (p === "/mock/big" && m === "POST") {
      const body = await json()
      if (typeof body.messages === "number") big.messages = body.messages
      if (typeof body.delayMs === "number") big.delayMs = body.delayMs
      if (typeof body.failOlder === "boolean") big.failOlder = body.failOlder
      if (body.on === true && !sessions.some((x) => x.id === BIG)) {
        big.rows = bigRows(0, big.messages)
        sessions.push(bigFixture())
        emitCatalog()
      }
      if (typeof body.append === "number") {
        const count = new Set(big.rows.map((r) => r.messageID)).size
        big.rows.push(...bigRows(count, body.append))
      }
      return Response.json({ rows: big.rows.length })
    }
    if (p === "/mock/decision" && m === "POST") {
      const body = await json()
      const decision = mockDecision(body)
      if (body.silent !== true) emit({ type: "decision", decision })
      return Response.json({ decision })
    }
    if (p === "/mock/emit" && m === "POST") {
      emit(await json())
      return Response.json({ ok: true, clients: clients.size })
    }
    if (p === "/mock/slow-turns" && m === "POST") {
      const ms = (await json()).ms
      slowTurnMs = typeof ms === "number" ? ms : undefined
      return Response.json({ ok: true })
    }
    if (p === "/mock/hold-turns" && m === "POST") {
      holdTurns = (await json()).on === true
      if (!holdTurns) {
        releaseTurn?.()
        releaseTurn = undefined
      }
      return Response.json({ ok: true })
    }
    if (p === "/mock/status" && m === "POST") {
      status = (await json()).sessions
      emit({ type: "status", sessionID: SESSION, sessions: status })
      return Response.json({ ok: true, clients: clients.size })
    }
    if (p === "/mock/stream" && m === "POST") {
      const body = await json()
      const kind = body.kind === "reasoning" ? "reasoning" : "text"
      void streamText(kind, body.sessionID ?? SESSION, body.messageID ?? "msg_stream", String(body.text ?? ""), body.every ?? 100, body.size ?? 7)
      return Response.json({ ok: true, clients: clients.size })
    }
    if (p === "/mock/scenario" && m === "POST") {
      void scenario()
      return Response.json({ ok: true, clients: clients.size })
    }
    if (p === "/mock/activity" && m === "POST") {
      const body = await json()
      const sessionID = body.sessionID ?? SESSION
      const item = { ...body.item, sessionID, at: body.item?.at ?? Date.now() }
      const i = activity.findIndex((x) => x.id === item.id)
      if (i >= 0) activity[i] = item
      else activity.push(item)
      if (activity.length > 30) activity.shift()
      emit({ type: "activity", sessionID, rootID: SESSION, item })
      return Response.json({ ok: true, clients: clients.size })
    }
    if (p === "/mock/session" && m === "POST") {
      const body = await json()
      const s = sessions.find((x) => x.id === body.id)
      if (!s) return Response.json({ error: "no such session" }, { status: 404 })
      Object.assign(s, body)
      emitCatalog()
      return Response.json({ ok: true, session: s })
    }
    if (p === "/mock/auto-name" && m === "POST") {
      autoName = { ...autoName, ...(await json()) }
      return Response.json(autoName)
    }
    if (p === "/mock/fail" && m === "POST") {
      fail = { ...fail, ...(await json()) }
      return Response.json(fail)
    }
    if (p === "/mock/prefs" && m === "POST") {
      const body = await json()
      const as = typeof body.as === "string" ? body.as : mainOwner()
      const bad = applyPrefs(as, body)
      if (bad) return Response.json({ error: bad }, { status: 400 })
      emit({ type: "prefs", userID: as })
      return Response.json({ prefs: prefsOf(as), clients: clients.size })
    }
    if (p === "/mock/herdr" && m === "POST") {
      const body = await json()
      herdr = { on: typeof body.on === "boolean" ? body.on : herdr.on, fail: typeof body.fail === "boolean" ? body.fail : herdr.fail }
      emitCatalog()
      return Response.json(herdr)
    }
    if (p === "/mock/service" && m === "POST") {
      serviceConnected = !!(await json()).connected
      emitCatalog()
      return Response.json({ connected: serviceConnected })
    }
    if (p === "/mock/order" && m === "POST") {
      const body = await json()
      if (body.on === true && !sessions.some((x) => x.id === ORDER)) {
        sessions.push(orderFixture())
        emitCatalog()
      }
      if (body.live === true) void orderLive()
      return Response.json({ rows: orderRows().length })
    }
    if (p === "/mock/auth" && m === "POST") {
      const body = await json()
      if (body.mode === "pairing" || body.mode === "oidc") authMode = body.mode
      if (typeof body.as === "string" && userByID(body.as)) loginAs = body.as
      emitCatalog()
      return Response.json({ mode: authMode, as: loginAs })
    }
    if (p === "/mock/agent-entry" && m === "POST") {
      const entry = recordAgent(await json())
      emit({ type: "agent", entry })
      return Response.json({ entry })
    }
    if (p === "/mock/agent-entries" && m === "POST") {
      const { count = 0 } = await json()
      for (let i = 0; i < count; i++) recordAgent({ verb: "stop", target: { sessionID: SESSION }, grant: null, actor: { kind: "app", tokenID: "0123456789abcdef", label: `filler ${i + 1}` } })
      return Response.json({ entries: agentAudit.length })
    }
    if (p === "/mock/log") return Response.json({ grants, agentAudit, log, textEnded, transcripts, conversation, pushPrefs, quietHours, activityMinutes, pushEndpoints, mutedSessions, pushTests, pushTestKinds, speech, keys, users, audit, enrollments, userSpeech: Object.fromEntries(userSpeech), viewPrefs: Object.fromEntries(viewPrefs), herdr })
    if (p === "/mock/reset" && m === "POST") {
      scenarioRun++
      big = { on: false, messages: 900, delayMs: 0, failOlder: false, rows: [] }
      order = { messages: ORDER_LIVE[0], run: order.run + 1 }
      slowTurnMs = undefined
      log = []
      transcripts = []
      activity = []
      status = [{ id: SESSION, title: "Mock session", state: "idle", blockers: [] }]
      sessions = fixtures()
      fail = { expose: false, create: false, models: false, prefs: false, modelPrefs: false, rename: false }
      autoName = defaultAutoName()
      reads = {}
      modelPrefs = {}
      turnRun++
      serviceConnected = true
      herdr = { on: true, fail: false }
      viewPrefs = new Map()
      users = seedUsers()
      extraMachines = seedMachines()
      devices = seedDevices()
      linkCodes = new Map()
      audit = seedAudit()
      enrollments = seedEnrollments()
      userSpeech = new Map()
      mockDecisions = []
      grants = []
      actingPaused = false
      hubActingPaused = false
      agentAudit = []
      speech = seedSpeech()
      keys = { stt: "sk-or-v1-mock-stt-1234", tts: undefined }
      pushPrefs = { ...DEFAULT_PUSH_PREFS, say: false }
      quietHours = null
      activityMinutes = 5
      pushEndpoints = []
      mutedSessions = []
      pushTests = 0
      pushTestKinds = []
      workstation = false
      harnessSpokes = false
      forcedUnsupported = new Set()
      emitCatalog()
      return Response.json({ ok: true })
    }
    if (p === "/mock/redeem" && m === "POST") {
      const body = await json()
      const grant = linkCodes.get(body.code)
      linkCodes.delete(body.code)
      if (!grant || grant.expiresAt < Date.now()) return Response.json({ error: "Invalid or expired link code" }, { status: 401 })
      const device = { id: `dev_app_${devices.length + 1}`, name: String(body.deviceName ?? "App"), ownerID: grant.ownerID, lastSeen: Date.now() }
      devices.push(device)
      record(grant.ownerID, "device.pair", device.id, "app link")
      return Response.json({ device, token: "mock-device-token" })
    }
    if (p === "/mock/harness" && m === "POST") {
      harnessSpokes = (await json()).on !== false
      sessions = sessions.filter((s) => !s.proc)
      if (harnessSpokes) sessions.push(...harnessFixtures())
      emitCatalog()
      return Response.json({ ok: true, sessions: [CC_SESSION, PRESET_SESSION] })
    }
    if (p === "/mock/unsupported" && m === "POST") {
      const features = (await json()).features
      forcedUnsupported = new Set(Array.isArray(features) ? features.filter((f: unknown): f is string => typeof f === "string") : [])
      return Response.json({ ok: true })
    }
    if (p === "/mock/workstation" && m === "POST") {
      workstation = (await json()).on !== false
      emitCatalog()
      return Response.json({ ok: true })
    }
    if (p === "/mock/push" && m === "POST") {
      // Acts as the hub losing (or holding) this device's subscriptions, e.g. after a move to a new origin.
      pushEndpoints = (await json()).endpoints ?? []
      return Response.json({ ok: true })
    }

    // ---------- auth (public) ----------
    if (p === "/api/auth") return Response.json({ mode: authMode, signIn: authMode === "oidc" ? "/auth/login" : null })
    if (p === "/auth/login") {
      if (authMode !== "oidc") return page("Sign-in is off", "This voice server uses pairing codes.")
      const as = url.searchParams.get("as") ?? loginAs
      const user = userByID(as)
      if (!user || user.disabled || user.id === "local") return page("Not allowed", "This Google account is not allowed on this voice server. Ask the admin to add it.")
      record(user.id, "signin")
      return signedIn(user.id, safeNext(url.searchParams.get("next")))
    }
    if (p === "/auth/callback") {
      const error = url.searchParams.get("error")
      return page("Sign-in failed", error ? `The sign-in provider answered “${error.replace(/[<>&"]/g, "")}”. Try again.` : "The sign-in link expired. Try again.")
    }
    if (p === "/api/pair" && m === "POST") {
      const body = await json()
      if (body.code !== "123456") return Response.json({ error: "Invalid or expired pairing code" }, { status: 401 })
      const id = authMode === "oidc" ? "u_alice" : "local"
      return Response.json({ device: { id: "dev_paired", name: body.deviceName } }, { headers: { "set-cookie": `mock_user=${id}; Path=/; HttpOnly; SameSite=Lax` } })
    }
    const me = p.startsWith("/api/") ? whoami(request) : undefined
    if (p.startsWith("/api/") && !me) return Response.json({ error: "This device is not paired" }, { status: 401 })
    const user = me!
    const admin = user?.role === "admin"
    const forbidden = () => Response.json({ error: "Admins only" }, { status: 403 })
    const notFound = () => Response.json({ error: "Not found" }, { status: 404 })
    if (p === "/api/logout" && m === "POST") {
      return new Response(null, { status: 204, headers: { "set-cookie": "mock_user=out; Path=/; HttpOnly; SameSite=Lax" } })
    }

    if (p === "/api/me") {
      return Response.json({
        device: { id: user.id === "u_bob" ? "dev_bob_chrome" : "dev_1", name: "Chrome" },
        user: { id: user.id, ...(user.email ? { email: user.email } : {}), ...(user.name ? { name: user.name } : {}), role: user.role },
        auth: authMode,
        publicURL: `http://127.0.0.1:${PORT}`,
        version: "mock",
      })
    }
    if (p === "/api/events") return sse(request, user)
    if (p === "/api/decisions" && m === "GET") {
      const state = url.searchParams.get("state")
      return Response.json({ decisions: mockDecisions.filter((d) => !state || d.state === state).sort((a, b) => b.at - a.at) })
    }
    if ((match0 = /^\/api\/decisions\/([^/]+)(\/answer)?$/.exec(p))) {
      const decision = mockDecisions.find((d) => d.id === decodeURIComponent(match0![1]!))
      if (!match0[2] && m === "GET") return decision ? Response.json({ decision }) : Response.json({ error: "No such decision", code: "not_found" }, { status: 404 })
      if (match0[2] && m === "POST") {
        const body = await json()
        last().body = body
        if (!decision) return Response.json({ error: "No such decision", code: "not_found" }, { status: 404 })
        if (decision.state !== "open") return Response.json({ error: "The decision is already answered or expired", code: "gone" }, { status: 409 })
        if (decision.options.length ? !decision.options.some((o: any) => o.id === body.option) : typeof body.text !== "string" || !body.text.trim()) {
          return Response.json({ error: "Pick one of the options", code: "invalid" }, { status: 400 })
        }
        Object.assign(decision, { state: "answered", answer: { ...(body.option ? { option: body.option } : {}), ...(body.text ? { text: body.text } : {}), answeredBy: "user", at: Date.now() } })
        emit({ type: "decision", decision })
        return Response.json({ decision })
      }
    }
    // ---------- agents ----------
    if (p === "/api/agent/grants" && m === "GET") return Response.json({ grants: [...grants].sort((a, b) => b.created - a.created).map(grantView) })
    if (p === "/api/agent/grants" && m === "POST") {
      const body = await json()
      last().body = body
      const spec = grantSpec(body)
      if (spec instanceof Response) return spec
      const grant = { id: `g_${String(++grantSeq).padStart(16, "0")}`, ...spec, ...(spec.holder.startsWith("@") && !spec.holder.startsWith("@@") ? { holderSessionID: SESSION } : {}), created: Date.now() } as MockGrant
      grants.push(grant)
      return Response.json({ grant: grantView(grant) }, { status: 201 })
    }
    if ((match0 = /^\/api\/agent\/grants\/([^/]+)$/.exec(p))) {
      const grant = grants.find((g) => g.id === decodeURIComponent(match0![1]!))
      if (!grant) return agentError(404, "not_found", "No such grant")
      if (m === "GET") return Response.json({ grant: grantView(grant) })
      if (m === "PUT" || m === "DELETE") {
        const body = m === "PUT" ? await json() : {}
        if (m === "PUT") last().body = body
        if (grantState(grant) !== "active") return agentError(410, "gone", `The grant is ${grantState(grant)}`)
        if (m === "DELETE") {
          grant.revokedAt = Date.now()
          return Response.json({ grant: grantView(grant) })
        }
        const spec = grantSpec(body)
        if (spec instanceof Response) return spec
        if (spec.holder !== grant.holder) return agentError(400, "invalid", "A grant's holder cannot change: revoke it and create another")
        Object.assign(grant, spec, { updated: Date.now() })
        return Response.json({ grant: grantView(grant) })
      }
    }
    if (p === "/api/agent/acting") {
      if (m === "PUT") {
        const body = await json()
        last().body = body
        if (typeof body.enabled !== "boolean") return agentError(400, "invalid", "enabled must be true or false")
        actingPaused = !body.enabled
        recordAgent({ actor: { kind: "user" }, verb: body.enabled ? "acting.resume" : "acting.pause", target: {}, grant: null })
      }
      return Response.json({ enabled: !actingPaused, hubEnabled: !hubActingPaused })
    }
    if (p === "/api/agent/audit" && m === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100)
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : Infinity
      const older = [...agentAudit].reverse().filter((e) => e.seq < before)
      const entries = older.slice(0, limit)
      return Response.json({ entries, ...(older.length > limit ? { next: entries[entries.length - 1]!.seq } : {}) })
    }
    if (p === "/api/enrollments") return admin ? Response.json({ enrollments }) : forbidden()
    if ((match0 = /^\/api\/enrollments\/([^/]+)\/(approve|deny)$/.exec(p)) && m === "POST") {
      const code = decodeURIComponent(match0[1]!).toUpperCase()
      const e = enrollments.find((x) => x.userCode === code)
      if (!e) return Response.json({ error: "No pending request with this code" }, { status: 404 })
      enrollments = enrollments.filter((x) => x !== e)
      const id = `mac_${e.machineName}`
      if (match0[2] === "approve") extraMachines.push({ id, name: e.machineName, ownerID: user.id, online: true, created: Date.now(), lastSeen: Date.now() })
      record(user.id, `machine.${match0[2]}`, match0[2] === "approve" ? id : undefined, e.machineName)
      emit({ type: "enrollment" })
      emitCatalog()
      return Response.json({ ok: true })
    }

    // ---------- admin ----------
    if (p.startsWith("/api/admin/") && !admin) return forbidden()
    const ownedMachines = (id: string) => (id === mainOwner() ? 2 : 0) + extraMachines.filter((x) => x.ownerID === id).length
    const ownedDevices = (id: string) => (id === mainOwner() ? 1 : 0) + devices.filter((x) => x.ownerID === id).length
    // In oidc mode `local` is kept but disabled (migrated to the first admin).
    const visibleUsers = () => (authMode === "pairing" ? users.filter((u) => u.id === "local") : users.map((u) => (u.id === "local" ? { ...u, disabled: true } : u)))
    if (p === "/api/admin/users" && m === "GET") {
      return Response.json(visibleUsers().map((u) => ({ ...u, disabled: !!u.disabled, machines: ownedMachines(u.id), devices: ownedDevices(u.id) })))
    }
    if ((match0 = /^\/api\/admin\/users\/([^/]+)$/.exec(p)) && m === "PUT") {
      const target = userByID(decodeURIComponent(match0[1]!))
      if (!target || !visibleUsers().some((u) => u.id === target.id)) return notFound()
      const body = await json()
      last().body = body
      const next = { ...target, ...(body.role === "admin" || body.role === "user" ? { role: body.role } : {}), ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}) }
      const admins = visibleUsers().map((u) => (u.id === target.id ? next : u)).filter((u) => u.role === "admin" && !u.disabled)
      if (!admins.length) return Response.json({ error: "Cannot demote or disable the last active admin. Make someone else an admin first." }, { status: 409 })
      if (next.role !== target.role) record(user.id, "user.role", target.id, next.role)
      if (!!next.disabled !== !!target.disabled) record(user.id, next.disabled ? "user.disable" : "user.enable", target.id)
      Object.assign(target, next)
      return Response.json({ ...target, disabled: !!target.disabled, machines: ownedMachines(target.id), devices: ownedDevices(target.id) })
    }
    if (p === "/api/admin/machines" && m === "GET") {
      const email = (id: string) => userByID(id)?.email ?? id
      const owner = mainOwner()
      return Response.json([
        ...machinesOf(userByID(owner)!).filter((x) => x.id === "mac_1" || x.id === "mac_2").map((x) => ({ ...x, ownerID: owner, ownerEmail: email(owner) })),
        ...extraMachines.map((x) => ({ ...x, ownerEmail: email(x.ownerID) })),
      ])
    }
    if ((match0 = /^\/api\/admin\/(machines|devices)\/([^/]+)$/.exec(p)) && m === "DELETE") {
      const id = decodeURIComponent(match0[2]!)
      if (match0[1] === "machines") {
        if (!extraMachines.some((x) => x.id === id)) return notFound()
        extraMachines = extraMachines.filter((x) => x.id !== id)
        record(user.id, "machine.revoke", id)
        emitCatalog()
      } else {
        if (!devices.some((x) => x.id === id)) return notFound()
        devices = devices.filter((x) => x.id !== id)
        record(user.id, "device.revoke", id)
      }
      return new Response(null, { status: 204 })
    }
    if (p === "/api/admin/audit" && m === "GET") return Response.json([...audit].reverse().slice(0, 200))
    if (p === "/api/admin/agents/acting") {
      if (m === "PUT") {
        const body = await json()
        last().body = body
        if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be true or false" }, { status: 400 })
        hubActingPaused = !body.enabled
        record(user.id, body.enabled ? "agents.acting.resume" : "agents.acting.pause")
      }
      return Response.json({ enabled: !hubActingPaused })
    }
    if ((match0 = /^\/api\/machines\/([^/]+)$/.exec(p)) && m === "DELETE") {
      const id = decodeURIComponent(match0[1]!)
      if (!extraMachines.some((x) => x.id === id && x.ownerID === user.id)) return notFound()
      extraMachines = extraMachines.filter((x) => x.id !== id)
      record(user.id, "machine.revoke", id)
      emitCatalog()
      return new Response(null, { status: 204 })
    }

    // ---------- sessions: other people's are 404 ----------
    const sessionRoute = /^\/api\/sessions\/([^/]+)/.exec(p)
    if (sessionRoute && !canSee(user, decodeURIComponent(sessionRoute[1]!))) return notFound()
    if (p === `/api/sessions/${BOB_SESSION}` && m === "GET") return Response.json({ ...catalogSession(bobSession()), activity: [] })
    if (p === `/api/sessions/${BOB_SESSION}/context`) return Response.json({ messages: [{ role: "assistant", text: "Hi Bob, groceries app here." }] })
    if (p === `/api/sessions/${BOB_SESSION}/presence`) return new Response(null, { status: 204 })
    if (p === `/api/sessions/${SESSION}` && m === "GET") {
      return Response.json({ ...mockSession(), state: status[0]?.state, activity })
    }
    if (p === `/api/sessions/${SESSION}/presence` && m === "POST") {
      last().body = await json()
      return new Response(null, { status: 204 })
    }
    let match: RegExpExecArray | null
    if ((match = /^\/api\/machines\/([^/]+)\/sessions$/.exec(p)) && m === "POST") {
      const body = await json()
      last().body = body
      await Bun.sleep(250)
      if (fail.create) return Response.json({ error: "OpenCode could not create the session" }, { status: 502 })
      const onMachine = decodeURIComponent(match[1]!)
      if (!(onMachine === "mac_1" || (onMachine === "mac_5" && workstation)) || !serviceConnected) {
        return Response.json({ error: "The background service of this machine is not connected" }, { status: 409 })
      }
      if (typeof body.directory !== "string" || !body.directory.startsWith("/")) return Response.json({ error: "directory must be absolute" }, { status: 400 })
      const ws = projectOf(body.directory)
      const id = `ses_new_${++created}`
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : ""
      const fixture: Fixture = { ...(onMachine === "mac_5" ? { machine: "mac_5" } : {}), id, title, directory: body.directory, project: ws?.[0], projectName: ws?.[1], updated: Date.now(), exposed: true, state: "idle", blockers: [] }
      let result: Record<string, unknown> = { sessionID: id }
      if (typeof body.herdrWorkspace === "string") {
        const target = HERDR.find((w) => w.id === body.herdrWorkspace)
        if (!herdr.on || herdr.fail || !target) {
          result = { sessionID: id, warning: herdr.fail ? "Herdr could not open a tab: herdr server is not running" : `Herdr workspace ${body.herdrWorkspace} not found` }
        } else {
          Object.assign(fixture, inHerdr(target.id, title || "New session")(fixture))
          result = { sessionID: id, openedIn: "herdr" }
        }
      }
      sessions.push(fixture)
      emitCatalog()
      return Response.json(result, { status: 201 })
    }
    const consoleReply = await consoleRoute(request, url, user)
    if (consoleReply) return consoleReply
    if ((match = /^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(p)) && decodeURIComponent(match[1]!) !== SESSION) {
      const id = decodeURIComponent(match[1]!)
      const action = match[2]
      const s = sessions.find((x) => x.id === id)
      if (!s) return notFound()
      if (action === "rename" && m === "POST") {
        const body = await json()
        last().body = body
        if (body.auto === true) {
          await Bun.sleep(600)
          if (autoName.mode === "outdated") return Response.json({ error: "Update the Hub plugin to use Auto-name", code: "plugin_outdated" }, { status: 409 })
          if (autoName.mode === "fail") return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
          if (autoName.mode === "same") return Response.json({ title: s.title, unchanged: true })
          const named = autoName.title
          if (autoName.mode === "pending") {
            setTimeout(() => {
              s.title = named
              emitCatalog()
            }, 1500)
            return Response.json({ pending: true }, { status: 202 })
          }
          s.title = named
          emitCatalog()
          return Response.json({ title: named })
        }
        await Bun.sleep(300)
        const title = typeof body.title === "string" ? body.title.trim() : ""
        if (!title || title.length > 200) return Response.json({ error: "Expected {title}: a non-empty title" }, { status: 400 })
        if (fail.rename) return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
        s.title = title
        emitCatalog()
        return Response.json({ title })
      }
      if (action === "expose" && m === "POST") {
        const body = await json()
        last().body = body
        await Bun.sleep(400)
        if (fail.expose) return Response.json({ error: "OpenCode did not answer" }, { status: 502 })
        s.exposed = !!body.on
        emitCatalog()
        return Response.json({ exposed: s.exposed })
      }
      // Inspection and control work with Voice off; only conversation and utterances need it.
      if (!s.exposed && (action === "conversation" || action === "utterance")) return Response.json(NOT_EXPOSED, { status: 403 })
      if (!action && m === "GET") return Response.json({ ...catalogSession(s), activity: [] })
      if (action === "context") return Response.json({ messages: [{ role: "assistant", text: `Hi, this is “${s.title || "Untitled"}”.` }] })
      if (action === "presence") return new Response(null, { status: 204 })
      if (action === "conversation" && m === "POST") {
        const body = await json()
        last().body = body
        s.conversation = !!body.on
        emit({ type: "conversation", sessionID: id, on: s.conversation })
        return Response.json({ on: s.conversation, agent: "voice" })
      }
      if (action === "turn" && m === "POST") return Response.json({ outcome: "succeeded", reply: `You said: ${(await json()).text}` })
      if (action === "utterance" && m === "POST") return Response.json({ inboxID: `inb_${++inbox}` }, { status: 202 })
      if (action === "interrupt" && m === "POST") return new Response(null, { status: 204 })
    }
    if (p === "/api/prefs/view" && m === "GET") return Response.json({ prefs: prefsOf(user.id) })
    if (p === "/api/prefs/view" && m === "PUT") {
      const body = await json()
      last().body = body
      await Bun.sleep(200)
      if (fail.prefs) return Response.json({ error: "The hub could not save your view settings" }, { status: 502 })
      const bad = applyPrefs(user.id, body)
      if (bad) return Response.json({ error: bad }, { status: 400 })
      emit({ type: "prefs", userID: user.id })
      return Response.json({ prefs: prefsOf(user.id) })
    }
    const pushView = (endpoint?: string | null) => ({
      prefs: pushPrefs,
      quietHours,
      activityMinutes,
      muted: mutedSessions,
      subscriptions: pushEndpoints.length,
      ...(endpoint ? { subscribed: pushEndpoints.includes(endpoint) } : {}),
    })
    if (p === "/api/push/prefs" && m === "GET") return Response.json(pushView(url.searchParams.get("endpoint")))
    if (p === "/api/push/prefs" && m === "PUT") {
      const body = await json()
      last().body = body
      for (const [k, v] of Object.entries(body)) if (k in pushPrefs && typeof v === "boolean") pushPrefs[k] = v
      if ("quietHours" in body) quietHours = body.quietHours
      if (typeof body.activityMinutes === "number") activityMinutes = body.activityMinutes
      return Response.json(pushView())
    }
    if (p === "/api/push/key" && m === "GET") return Response.json({ publicKey: "BNbxGYNMhEIi9zrneh7mqV4oUanjLUK3m-mYZBc62frMKrEoMk88r3Lk596T0ck9xlT-hA0ITRxIFxeuybYCcQ8" })
    if (p === "/api/push/subscribe" && m === "POST") {
      const body = await json()
      last().body = body
      const endpoint = body.subscription?.endpoint
      if (typeof endpoint !== "string") return Response.json({ error: "Invalid push subscription" }, { status: 400 })
      if (!pushEndpoints.includes(endpoint)) pushEndpoints.push(endpoint)
      return Response.json({ prefs: pushPrefs })
    }
    if (p === "/api/push/unsubscribe" && m === "POST") {
      const body = await json()
      pushEndpoints = pushEndpoints.filter((e) => e !== body.endpoint)
      return new Response(null, { status: 204 })
    }
    if (p === "/api/push/test" && m === "POST") {
      pushTests++
      const body = await json()
      pushTestKinds.push(typeof body.kind === "string" ? body.kind : "")
      return Response.json({ sent: pushEndpoints.length, failed: [], subscriptions: pushEndpoints.length })
    }
    if (p === "/api/push/mute" && m === "PUT") {
      const body = await json()
      last().body = body
      mutedSessions = mutedSessions.filter((id) => id !== body.sessionID)
      if (body.muted) mutedSessions.push(body.sessionID)
      return Response.json({ muted: mutedSessions })
    }
    if (p === "/api/devices") {
      const current = { id: user.id === "u_bob" ? "dev_bob_chrome" : "dev_1", name: "Chrome", lastSeen: Date.now(), current: true }
      return Response.json({ devices: [current, ...devices.filter((d) => d.ownerID === user.id)] })
    }
    if (p === "/api/devices/link" && m === "POST") {
      const code = crypto.randomUUID().replaceAll("-", "") + "linkcode000"
      const expiresAt = Date.now() + 5 * 60_000
      linkCodes.set(code, { ownerID: user.id, expiresAt })
      const hub = url.origin
      return Response.json({ code, expiresAt, hub, url: `hubapp://link?hub=${encodeURIComponent(hub)}&code=${code}` })
    }
    if ((match0 = /^\/api\/devices\/([^/]+)$/.exec(p)) && m === "DELETE") {
      const id = decodeURIComponent(match0[1]!)
      if (!devices.some((d) => d.id === id && d.ownerID === user.id)) return notFound()
      devices = devices.filter((d) => d.id !== id)
      record(user.id, "device.revoke", id)
      return new Response(null, { status: 204 })
    }
    if (p === "/api/settings/speech" && m === "GET") return Response.json(userSpeechSettings(user))
    if (p === "/api/settings/speech" && m === "PUT") {
      const body = await json()
      last().body = body
      const own = ownOf(user.id)
      const bad = applySpeech(body, own, (kind, key) => (own.keys[kind] = key), true)
      if (bad) return Response.json(bad, { status: 400 })
      return Response.json(userSpeechSettings(user))
    }
    if (p === "/api/settings/speech/default" && m === "GET") return admin ? Response.json(speechSettings()) : forbidden()
    if (p === "/api/settings/speech/default" && m === "PUT") {
      if (!admin) return forbidden()
      const body = await json()
      last().body = body
      const bad = applySpeech(body, speech as unknown as Own, (kind, key) => (keys[kind] = key), false)
      if (bad) return Response.json(bad, { status: 400 })
      record(user.id, "speech.default")
      return Response.json(speechSettings())
    }
    if (p === "/api/settings/speech/models" && m === "GET") {
      await Bun.sleep(300)
      if (fail.models) return Response.json({ error: "OpenRouter is unreachable" }, { status: 502 })
      const kind = url.searchParams.get("kind") === "stt" ? "stt" : "tts"
      // A big OpenAI-compatible gateway list (trimmed real fixture), classified like the hub does.
      return Response.json(speechModelList(kind, gatewayModels, speech[kind].model))
    }
    if (p === "/api/settings/speech/test" && m === "POST") {
      last().body = await json()
      return new Response(toneWav("This is how replies will sound."), { headers: { "content-type": "audio/wav" } })
    }
    if (p === `/api/sessions/${SESSION}/context`) return Response.json({ messages: [{ role: "assistant", text: "Hi, mock session here." }] })
    if (p === `/api/sessions/${SESSION}/conversation` && m === "POST") {
      const body = await json()
      last().body = body
      conversation = !!body.on
      emit({ type: "conversation", sessionID: SESSION, on: conversation })
      return Response.json({ on: conversation, agent: "voice" })
    }
    if (p === "/api/transcribe" && m === "POST") {
      const audio = new Uint8Array(await request.arrayBuffer())
      last().bytes = audio.length
      await Bun.sleep(300)
      return Response.json({ text: transcripts.shift() ?? "" })
    }
    if (p === `/api/sessions/${SESSION}/utterance` && m === "POST") {
      const body = await json()
      last().body = body
      const inboxID = `inb_${++inbox}`
      setTimeout(() => emit({ type: "heard", sessionID: SESSION, inboxID }), 400)
      return Response.json({ inboxID }, { status: 202 })
    }
    if (p === `/api/sessions/${SESSION}/interrupt` && m === "POST") return new Response(null, { status: 204 })
    if (p === "/api/speak" && m === "POST") {
      const body = await json()
      last().body = body
      await Bun.sleep(150)
      // Streamed like a real provider: playback can start long before the last byte arrives.
      const entry = last()
      const size = Math.ceil(TONE_MP3.length / SPEAK_CHUNKS)
      let sent = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const audio = new ReadableStream<Uint8Array>({
        start(controller) {
          const next = () => {
            try {
              controller.enqueue(TONE_MP3.slice(sent, (sent += size)))
              if (sent < TONE_MP3.length) timer = setTimeout(next, SPEAK_EVERY_MS)
              else {
                entry.done = Date.now()
                controller.close()
              }
            } catch {
              // the phone cancelled (barge-in)
            }
          }
          next()
        },
        cancel() {
          clearTimeout(timer)
        },
      })
      return new Response(audio, { headers: { "content-type": "audio/mpeg" } })
    }
    if (p.startsWith("/api/")) return notFound()

    const file = /^\/(?:|pair|approve|new|settings|s\/[^/]+)$/.test(p) ? path.join(WEB, "index.html") : path.resolve(WEB, `.${p}`)
    const type = TYPES[path.extname(file)]
    if (!type || !file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) return new Response("Not found", { status: 404 })
    return new Response(readFileSync(file), { headers: { "content-type": type, "cache-control": "no-cache" } })
  },
})

console.log(`[mock-hub] http://127.0.0.1:${server.port}/ (home) · /s/${SESSION}`)
