// One session: top bar, transcript (history + live), permission/question cards, Voice bar, composer, right rail
// and diff viewer. Works whether Voice is on or off; Voice mode turns Voice on first when needed.
import { jobsBadge, retryText, runningJobs } from "../core/jobs-core"
import { treeError } from "../core/error-core"
import { sessionHistory } from "../core/session-history"
import { For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { blockersOf } from "../core/browser-core"
import { reconcileSay, statusNotes, type StatusLike } from "../core/conversation-core"
import { speechSetup, type StatusEntry } from "../core/feedback-core"
import { storedMessageRow, Timeline } from "../core/timeline-core"
import { HistoryPager, type PageQuery } from "../core/history-core"
import { composerReducer, composerView, confirmDelivery, initialComposer, turnAnswer, turnOutcomeNote, type ComposerAction, type TurnResultLike } from "../lib/composer"
import { subtree, treeRunning } from "../lib/store"
import { transcriptBlocks, type Block } from "../lib/transcript"
import { createStore } from "solid-js/store"
import { unlockAudio } from "../voice/audio"
import { sessionMenu, setRenaming } from "./actions"
import { Naming, RenameTitle } from "./Rename"
import { api, errorText, getJSON, HttpError, NetworkError, sessionPath } from "./api"
import { prepareImage } from "./attach"
import { takeFirstTurn } from "./first-turn"
import { Composer, VoiceBar } from "./Composer"
import { agentEntries, decisions, hub, live, liveTick, lookup, markRead, me, onMessage, rows, speechReady } from "./hub"
import { isPhone, railOpen, setRailOpen, toggleSidebar } from "./layout"
import { ModelPicker, createModels, modelLabel, type ModelKind } from "./ModelMenu"
import { PanelHandle } from "./PanelHandle"
import { DiffPanel, Rail, type Summary } from "./Rail"
import { navigate, sessionHref } from "./router"
import { toast } from "./toast"
import { allowVoiceNotifications, dictation, dictationFor, drafts, voice, voiceNotifyHint, voiceState } from "./voice"
import { VoicePill } from "./VoicePill"
import { BlockerCard } from "./BlockerCard"
import { DecisionCards } from "./DecisionCard"
import { decisionsFor } from "../core/decision-core"
import { agentNotes } from "../core/agents-core"
import { Transcript, type TickState } from "./Transcript"
import { Icon, IconButton, Menu, STATE_LABEL, StatusIcon, ago, now } from "./ui"
import { formatElapsed } from "../core/feedback-core"
import { takeVoiceParam } from "../core/voice-autostart"
import { deliveryNote, evidenceBadge, promptGate, sessionControls, unsupportedNotice } from "../core/harness-core"

const PRESENCE_MS = 30_000
/** Timeline rows per history page: the newest page opens the session, older ones load while scrolling up. */
const HISTORY_PAGE = 80
const SUMMARY_THROTTLE_MS = 2000

/** The session a ?voice=1 link asked to start Voice mode in, until its view starts it. */
let voiceRequest: string | undefined

export function SessionView(props: { id: string }) {
  const id = props.id
  const found = () => lookup(id)
  const row = () => rows().find((r) => r.id === id)
  const status = () => found()?.session.status as readonly StatusEntry[] | undefined
  /** Something in this session's subtree works or waits (typed input steers, Stop applies). */
  const running = () => treeRunning(isChild() ? status()?.filter((s) => tree().has(s.id)) : status())
  const offline = () => !found()
  /** What the session's spoke serves: OpenCode everything; another harness only what it announced (P7-T10). */
  const controls = createMemo(() => sessionControls(found()?.process))
  const badge = () => evidenceBadge(controls())
  /** Whether the hub can show this session's transcript (a known session whose spoke has no timeline: no). */
  const noTimeline = () => !!found() && !controls().timeline
  const exposed = () => found()?.session.exposed !== false
  /** The root of the session's tree: itself, or (for a subagent session) the session that spawned the tree. */
  const treeRoot = () => (typeof found()?.session.rootID === "string" ? (found()!.session.rootID as string) : id)
  const isChild = () => treeRoot() !== id
  // Native mobile swipe-back must follow the session tree, not sidebar visit order.
  createEffect(() => {
    const session = found()?.session
    if (!isPhone() || !session) return
    const root = treeRoot() !== id ? treeRoot() : session.parentID
    sessionHistory(window.history, location.pathname + location.search + location.hash, typeof root === "string" ? root : undefined)
  })
  /** This session and the subagent sessions below it. */
  const tree = createMemo(() => subtree(status() as ReadonlyArray<{ id?: string; parentID?: string }> | undefined, id))
  /** Live events of the tree root that belong on this page (a subagent page shows only its own subtree). */
  const mine = (rootID: unknown, sessionID: unknown) => rootID === treeRoot() && (!isChild() || (typeof sessionID === "string" && tree().has(sessionID)))
  const parent = () => {
    const parentID = found()?.session.parentID
    if (typeof parentID !== "string" || !parentID) return undefined
    const title = (status() as ReadonlyArray<{ id: string; title?: string }> | undefined)?.find((s) => s.id === parentID)?.title || lookup(parentID)?.session.title
    return { id: parentID, title: title || "Parent session" }
  }

  // ---------- timeline ----------
  const timeline = new Timeline()
  const [rev, setRev] = createSignal(0)
  const bump = () => setRev((n) => n + 1)
  const [loaded, setLoaded] = createSignal(false)
  const [notFound, setNotFound] = createSignal(false)
  const [notes, setNotes] = createSignal<Array<{ key: string; text: string; kind: string }>>([])
  const [ticks, setTicks] = createSignal<Record<string, TickState>>({})
  let localSeq = 0
  const note = (text: string, kind = "") => setNotes((n) => [...n.slice(-20), { key: `n${++localSeq}`, text, kind }])
  // Unchanged blocks keep their identity, so live updates re-render only what changed.
  let previous = new Map<string, { json: string; block: Block }>()
  const blocks = createMemo(() => {
    rev()
    timeline.status(status() as unknown as Array<Record<string, unknown>>, id)
    const next = new Map<string, { json: string; block: Block }>()
    const out = transcriptBlocks(timeline.rows()).map((block) => {
      const json = JSON.stringify(block)
      const kept = previous.get(block.key)
      const entry = kept && kept.json === json ? kept : { json, block }
      next.set(block.key, entry)
      return entry.block
    })
    previous = next
    return out
  })
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  let scroller: HTMLDivElement | undefined
  let stick = true
  const toEnd = () => requestAnimationFrame(() => scroller && (scroller.scrollTop = scroller.scrollHeight))
  createEffect(on(blocks, () => stick && toEnd()))

  // ---------- history pages ----------
  const [historyRev, setHistoryRev] = createSignal(0)
  const pageQuery = (q: PageQuery) => new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString()
  const pager = new HistoryPager(timeline, (q) => getJSON(`${sessionPath(id)}/timeline?${pageQuery(q)}`), {
    limit: HISTORY_PAGE,
    onChange: () => {
      keepInView(() => batch(() => {
        setHistoryRev((n) => n + 1)
        bump()
      }))
      // Still near the top after a page (short pages, tall screens): the observer looks again.
      if (pager.state === "idle") watchTop()
    },
  })
  const history = () => (historyRev(), { state: pager.state, error: pager.error })
  /**
   * Applies a change above what is on screen without moving it: the first row in view keeps its offset (rows
   * prepended above it push the scroll position down by their height). At the bottom, the view stays stuck there.
   */
  function keepInView(change: () => void) {
    const el = scroller
    if (!el || stick) return change()
    const top = el.getBoundingClientRect().top
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".transcript > [data-key]"))
    const row = rows.find((r) => r.getBoundingClientRect().bottom > top + 1)
    const key = row?.dataset.key
    const before = row ? row.getBoundingClientRect().top : 0
    change()
    if (!key) return
    const same = Array.from(el.querySelectorAll<HTMLElement>(".transcript > [data-key]")).find((r) => r.dataset.key === key)
    if (same) el.scrollTop += same.getBoundingClientRect().top - before
  }
  let topObserver: IntersectionObserver | undefined
  let sentinel: HTMLDivElement | undefined
  /** Watches the top of the transcript: within ~1.5 screens of it, the next older page loads. */
  function watchTop() {
    if (!sentinel || !scroller || typeof IntersectionObserver === "undefined") return
    topObserver ??= new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void pager.older(), {
      root: scroller,
      rootMargin: `${Math.round(window.innerHeight * 1.5)}px 0px 0px 0px`,
    })
    // Observing again reports the current state, so a sentinel still in range loads the next page.
    topObserver.unobserve(sentinel)
    topObserver.observe(sentinel)
  }
  onCleanup(() => topObserver?.disconnect())
  /** The sentinel appears once the newest page shows: watch it after the view has scrolled to the bottom. */
  const setSentinel = (el: HTMLDivElement) => {
    sentinel = el
    requestAnimationFrame(() => requestAnimationFrame(watchTop))
  }

  async function loadTimeline() {
    if (noTimeline()) return setLoaded(true)
    try {
      await pager.first()
      setLoaded(true)
      bump()
      toEnd()
    } catch (e) {
      if (e instanceof HttpError && e.status === 404 && !found()) setNotFound(true)
      else if (noTimeline() || unsupportedNotice(e)) {
        // The spoke keeps no transcript the hub can read: the page says so instead of an error.
      } else note(e instanceof HttpError && e.status === 409 ? "No OpenCode process for this session is connected; history is unavailable until it reconnects." : `Could not load the conversation: ${errorText(e)}`, "err")
      setLoaded(true)
    }
  }

  /** Hub messages of the session (its sent ones and those not in its history yet), merged by time. */
  async function loadMessages() {
    try {
      const { messages } = await getJSON<{ messages?: unknown[] }>(`${sessionPath(id)}/messages?limit=200`)
      for (const raw of messages ?? []) {
        const row = storedMessageRow(id, raw)
        if (row) timeline.hubMessage(row)
      }
      bump()
    } catch {
      // older hubs have no message store: no message rows besides the history's
    }
  }

  async function loadBacklog() {
    try {
      const info = await getJSON(sessionPath(id))
      const feed = live.feed(treeRoot())
      feed.load(info.activity ?? [])
      if (info.status) feed.status(info.status)
    } catch {
      // live events fill the feed
    }
  }

  // ---------- live messages ----------
  let lastStatus: readonly StatusLike[] | undefined = untrack(() => status() as readonly StatusLike[] | undefined)
  const unsubscribe = onMessage((m) => {
    // The hub could not replay what this page missed while away: refetch the conversation and status.
    if (m.type === "resync") {
      // The newest page again, merged with the older pages already shown (or, after a gap, instead of them).
      if (loaded()) void pager.resync().catch((e) => note(`Could not refresh the conversation: ${errorText(e)}`, "err")).then(loadMessages)
      else void loadTimeline().then(loadMessages)
      void loadBacklog()
      void loadSummary()
      return
    }
    const rootID = typeof m.rootID === "string" ? m.rootID : m.sessionID
    if (m.type === "activity" && mine(rootID, m.sessionID) && m.item && m.item.kind !== "thinking") {
      // Tool steps; thinking shows up through streamed reasoning.
      timeline.activity(m.sessionID, m.item)
      bump()
    } else if (m.type === "reasoning" && mine(rootID, m.sessionID) && typeof m.messageID === "string" && typeof m.delta === "string") {
      timeline.appendReasoning({ sessionID: m.sessionID, messageID: m.messageID, delta: m.delta })
      bump()
    } else if (m.type === "delta" && mine(rootID, m.sessionID) && typeof m.messageID === "string" && typeof m.text === "string") {
      // Text after reasoning ends that reasoning.
      timeline.appendText({ sessionID: m.sessionID, messageID: m.messageID, ...(Number.isInteger(m.ordinal) ? { ordinal: m.ordinal } : {}), delta: m.text })
      bump()
    } else if (m.type === "message") {
      // A hub message this session sent or got (others: nothing).
      const row = storedMessageRow(id, m.message)
      if (row) {
        timeline.hubMessage(row)
        bump()
      }
    } else if (m.type === "turn" && m.sessionID === id && awaitingTurn) {
      const { sub, sentAt } = awaitingTurn
      awaitingTurn = undefined
      finishTurn(m as TurnResultLike, sub, sentAt)
    } else if (m.type === "status" && m.sessionID === treeRoot()) {
      for (const text of statusNotes(lastStatus, m.sessions, id)) note(text, "sys")
      lastStatus = m.sessions
      if (!treeRunning(m.sessions)) {
        for (const r of timeline.rows()) if (r.live) timeline.upsert({ key: r.key, live: false } as never)
        timeline.endReasoning(undefined)
      }
      bump()
      scheduleSummary()
    }
  })

  // ---------- read marks, presence ----------
  let readTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => found()?.session.updated,
      () => {
        clearTimeout(readTimer)
        readTimer = setTimeout(() => document.visibilityState === "visible" && void markRead(id), 400)
      },
    ),
  )
  const presence = (visible: boolean, keepalive = false) => api(`${sessionPath(id)}/presence`, { method: "POST", json: { visible }, keepalive }).catch(() => {})
  const onVisibility = () => {
    void presence(document.visibilityState === "visible", document.visibilityState !== "visible")
    if (document.visibilityState === "visible") void markRead(id)
  }
  let presenceTimer: ReturnType<typeof setInterval> | undefined

  // ---------- summary (right rail) ----------
  const [summary, setSummary] = createSignal<Summary | undefined>()
  const [summaryError, setSummaryError] = createSignal("")
  const [summaryLoading, setSummaryLoading] = createSignal(true)
  let summaryAt = 0
  let summaryTimer: ReturnType<typeof setTimeout> | undefined
  let warmups = 0
  async function loadSummary() {
    summaryAt = Date.now()
    if (found() && !controls().summary) {
      setSummaryError(`Details aren't available for ${controls().harnessName} sessions.`)
      return setSummaryLoading(false)
    }
    try {
      const s = await getJSON<Summary>(`${sessionPath(id)}/summary`)
      setSummary(s)
      setSummaryError("")
      // OpenCode warms up lazily: a first answer without branch/changes is retried a few seconds later.
      if ((!s.branch || !s.changes) && warmups < 2) {
        warmups++
        clearTimeout(summaryTimer)
        summaryTimer = setTimeout(loadSummary, 4000)
      }
    } catch (e) {
      setSummaryError(e instanceof HttpError && e.status === 409 ? "The machine is disconnected." : `Could not load details: ${errorText(e)}`)
    } finally {
      setSummaryLoading(false)
    }
  }
  function scheduleSummary() {
    clearTimeout(summaryTimer)
    summaryTimer = setTimeout(loadSummary, Math.max(0, SUMMARY_THROTTLE_MS - (Date.now() - summaryAt)))
  }
  const [diffFile, setDiffFile] = createSignal<string | undefined>()

  // ---------- models ----------
  const models = createModels(() => id)
  const [picker, setPicker] = createSignal<ModelKind | undefined>()

  // ---------- composer ----------
  // The draft lives in the app-level draft store, so it survives switching sessions and dictation can fill it.
  const [composer, setComposer] = createSignal({ ...initialComposer(), draft: drafts.get(id) })
  const act = (a: ComposerAction) => {
    setComposer((s) => composerReducer(s, a))
    drafts.set(id, composer().draft)
  }
  onCleanup(
    drafts.subscribe((changed) => {
      if (changed === id && drafts.get(id) !== composer().draft) setComposer((s) => composerReducer(s, { type: "input", text: drafts.get(id) }))
    }),
  )
  /** Typed input by what the spoke serves: no box without turn and steer, Send/Steer only when served. */
  const gate = () => promptGate(controls(), running())
  const view = () => {
    const base = composerView(composer(), { running: running(), offline: offline() })
    const g = gate()
    return { ...base, canSubmit: base.canSubmit && g.allowed, showStop: base.showStop && controls().stop, ...(!base.hint && g.hint ? { hint: g.hint } : {}) }
  }
  let submitSeq = 0

  // Images are prepared one at a time, in the order they were added.
  const [attaching, setAttaching] = createSignal(false)
  let attachQueue = Promise.resolve()
  function attach(files: File[]) {
    attachQueue = attachQueue.then(async () => {
      setAttaching(true)
      try {
        for (const file of files) {
          try {
            act({ type: "attach", image: await prepareImage(file, composer().images) })
          } catch (e) {
            act({ type: "attachError", message: errorText(e) })
          }
        }
      } finally {
        setAttaching(false)
      }
    })
  }

  async function submit() {
    const text = composer().draft.trim()
    const images = composer().images
    if (!text && !images.length) return
    // Voice mode speaks replies to utterances; a message with images goes as a typed turn instead.
    if (voiceHere() && !images.length) {
      act({ type: "input", text: "" })
      void voice.sendTyped(id, text)
      return
    }
    const sub = ++submitSeq
    const key = `local:${sub}`
    // A Send to a running tree is a steer; only an idle turn can be confirmed by the tree starting to run.
    const wasRunning = running()
    const sentAt = Date.now()
    batch(() => {
      act({ type: "submit", id: sub })
      timeline.upsert({ key, kind: "user", text, at: sentAt, ...(images.length ? { images: images.map(({ name, mime, preview }) => ({ name, mime, preview })) } : {}) })
      setTicks((t) => ({ ...t, [key]: "pending" }))
      bump()
    })
    stick = true
    toEnd()
    try {
      const json = { text, ...(images.length ? { images: images.map(({ mime, data, name }) => ({ mime, data, name })) } : {}) }
      // respond-async: the hub answers once the turn is under way instead of holding the request for the
      // whole turn (which proxies cut); the result comes as an SSE `turn` event.
      const res = await api(`${sessionPath(id)}/turn`, { method: "POST", json, headers: { prefer: "respond-async" } })
      const result = await res.json().catch(() => ({}))
      const answer = turnAnswer(res.status, result)
      act({ type: "accepted", id: sub })
      // Honest delivery: a hooks or screen spoke takes it at its next step (queued), never "steered" at once.
      const delivered = deliveryNote(controls(), answer)
      setTicks((t) => ({ ...t, [key]: delivered.tick }))
      if (delivered.toast) toast(delivered.toast)
      if (answer === "accepted") awaitingTurn = { sub, sentAt }
      else finishTurn(result, sub, sentAt)
    } catch (e) {
      // The connection dropped without an answer (e.g. a proxy cutting the long request): when the session runs,
      // the hub took the turn; its reply streams into the transcript, so the sent text stays out of the draft.
      if (e instanceof NetworkError && !wasRunning && (await confirmDelivery(running))) {
        act({ type: "accepted", id: sub })
        setTicks((t) => ({ ...t, [key]: "sent" }))
        note("Lost the connection to the hub after sending; the session is working on your message and its reply will appear here.", "sys")
        return
      }
      const unsupported = unsupportedNotice(e)
      if (unsupported) toast(unsupported, "err")
      const message = unsupported ?? (e instanceof HttpError && e.status === 504 ? "OpenCode did not answer in time. The session may still be working." : errorText(e))
      batch(() => {
        act({ type: "rejected", id: sub, message })
        timeline.upsert({ key, kind: "user", text: "", images: [] })
        bump()
      })
    }
  }

  /** The idle turn accepted with 202, until its SSE `turn` result arrives. */
  let awaitingTurn: { sub: number; sentAt: number } | undefined
  /** A finished turn: its reply when nothing streamed it, and a note unless it succeeded. */
  function finishTurn(result: TurnResultLike, sub: number, sentAt: number) {
    const streamed = timeline.rows().some((r) => r.kind === "assistant" && (r.at ?? 0) >= sentAt && r.text)
    if (result.reply && !streamed) timeline.upsert({ key: `reply:${sub}`, kind: "assistant", text: result.reply, at: Date.now() })
    const outcome = turnOutcomeNote(result)
    if (outcome) note(outcome.text, outcome.kind)
    bump()
  }

  async function stop() {
    act({ type: "stop" })
    try {
      const { stopped } = await (await api(`${sessionPath(id)}/stop`, { method: "POST", json: {} })).json()
      const n = Array.isArray(stopped) ? stopped.length : 0
      toast(n ? `Stopped ${n} session${n === 1 ? "" : "s"}` : "Nothing was running")
    } catch (e) {
      toast(unsupportedNotice(e) ?? `Could not stop: ${errorText(e)}`, "err")
    } finally {
      act({ type: "stopped" })
    }
  }

  // ---------- dictation ----------
  // App-level: the text goes into this session's draft; leaving the session while recording cancels it.
  const dictated = () => dictationFor(id)
  const dictate = () => dictation.toggle(id)

  // ---------- Voice mode ----------
  // App-level (one session at a time; it keeps running while other sessions are viewed). This view shows its
  // bubbles and notes while on screen.
  const vs = voiceState
  const voiceHere = () => vs().phase !== "off" && vs().sessionID === id
  const voiceElsewhere = () => vs().phase !== "off" && vs().sessionID !== undefined && vs().sessionID !== id
  const voiceError = () => (vs().error?.sessionID === id && !vs().error!.gesture ? vs().error!.message : undefined)
  /** The browser blocked starting Voice mode until the user taps (e.g. opened from /voice): a big button. */
  const voiceNeedsTap = () => vs().error?.sessionID === id && vs().error!.gesture === true
  const voiceBlocked = () => {
    const setup = speechSetup(speechReady() ?? undefined, me()?.publicURL)
    return setup?.micBlocked ? "Set up speech in Settings to use the microphone" : undefined
  }
  onCleanup(
    voice.attach(id, {
      user: (text) => {
        const key = `voice:${++localSeq}`
        timeline.upsert({ key, kind: "user", text, at: Date.now() })
        setTicks((t) => ({ ...t, [key]: "pending" }))
        bump()
        return key
      },
      tick: (key, kind) => setTicks((t) => ({ ...t, [key]: kind })),
      agent: (message) => {
        const key = message.messageID ? timeline.liveTextKey(message.messageID) : `say:${++localSeq}`
        const { mode, text } = reconcileSay(timeline.get(key)?.text ?? "", message.text)
        if (mode !== "keep") {
          timeline.upsert({ key, messageID: message.messageID, kind: "assistant", text, at: timeline.get(key)?.at ?? Date.now() })
          bump()
        }
      },
      note: (text, kind) => note(text, kind ?? "sys"),
    }),
  )

  /** The Voice button: Voice mode on here (turning it off elsewhere first), or off when it is on here. */
  async function toggleVoice() {
    if (!voiceHere()) {
      unlockAudio()
      dictation.cancel()
    }
    await voice.toggle(id)
    if (voice.isOn(id) && voice.state.phase === "on") note(`Voice mode on${voice.state.agent ? ` (${voice.state.agent} agent)` : ""}. Speak naturally; say “stop” to interrupt, “pause listening” to end.`, "sys")
  }

  // /s/<id>?voice=1 (from /voice in the TUI): Voice mode on once the session is known; the param goes away.
  // Kept outside the view: replacing the URL may mount the view again.
  const autostart = takeVoiceParam(location.href)
  if (autostart.voice) {
    voiceRequest = id
    navigate(autostart.path, { replace: true })
  }
  createEffect(() => {
    if (voiceRequest !== id || !found() || voiceBlocked()) return
    voiceRequest = undefined
    if (!voiceHere()) void toggleVoice()
  })

  // ---------- lifecycle ----------
  onMount(() => {
    // Started from /new: its prompt is this session's first turn.
    const first = takeFirstTurn(id)
    if (first) {
      batch(() => {
        act({ type: "input", text: first.text })
        for (const image of first.images) act({ type: "attach", image })
      })
      void submit()
    }
    void loadBacklog()
    void markRead(id)
    void presence(document.visibilityState === "visible")
    presenceTimer = setInterval(() => document.visibilityState === "visible" && void presence(true), PRESENCE_MS)
    document.addEventListener("visibilitychange", onVisibility)
  })
  // What the spoke serves is known once the catalog is: only then load the transcript, details and models, so a
  // session whose spoke has none of them (another harness) never asks for them (P7-T10).
  let started = false
  createEffect(() => {
    if (started || !hub.machines) return
    started = true
    untrack(() => {
      void loadTimeline().then(loadMessages)
      void loadSummary()
      if (!found() || controls().models) void models.load()
    })
  })
  const leave = () => void presence(false, true)
  window.addEventListener("pagehide", leave)
  onCleanup(() => {
    unsubscribe()
    clearInterval(presenceTimer)
    clearTimeout(summaryTimer)
    clearTimeout(readTimer)
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pagehide", leave)
    leave()
  })

  // A session that vanished from the catalog after being seen goes back home with a notice.
  let seen = false
  createEffect(() => {
    if (found()) seen = true
    else if (seen && hub.machines) {
      toast("That session is gone (deleted, or its machine was revoked).", "warn")
      navigate("/", { replace: true })
    }
  })

  // ---------- derived ----------
  const blockers = () => blockersOf(found()?.session).filter((b) => !isChild() || (b.sessionID !== undefined && tree().has(b.sessionID)))
  const blockerByID = createMemo(() => new Map(blockers().map((b) => [`${b.kind}:${b.id}`, b])))
  const blockerIDs = createMemo((prev: string[] = []) => {
    const next = [...blockerByID().keys()]
    return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
  })
  const answeredNotes = () => {
    const open = new Set(blockers().map((b) => b.id))
    return agentNotes(agentEntries(), new Set([id, ...tree()]), tick()).filter((n) => !open.has(n.key))
  }
  const pulse = () => {
    liveTick()
    now()
    return live.has(treeRoot()) ? live.feed(treeRoot()).pulse() : undefined
  }
  const [tick, setTick] = createSignal(Date.now())
  const ticker = setInterval(() => setTick(Date.now()), 1000)
  onCleanup(() => clearInterval(ticker))
  const working = () => {
    if (isChild()) {
      // The root's pulse describes the whole tree; a subagent page shows its own run.
      const own = (status() as ReadonlyArray<{ id: string; state: string; since?: number }> | undefined)?.find((s) => s.id === id)
      if (own?.state !== "working") return undefined
      tick()
      return `Working${own.since ? ` · ${formatElapsed(Date.now() - own.since)}` : ""}`
    }
    const p = pulse()
    if (!running() || !p?.busy) return undefined
    tick()
    const retrying = retryText(status(), id)
    const jobs = runningJobs(status())
    return `${retrying ?? p.label}${p.since ? ` · ${formatElapsed(Date.now() - p.since)}` : ""}${jobs ? ` · ${jobsBadge(jobs)}` : ""}`
  }
  /** The session (or a subagent of it) failed, e.g. "Quota exceeded"; gone once a new run starts. */
  const failure = () => treeError(status(), id)
  const metaLeft = () => {
    const s = found()?.session
    if (!s) return "Not connected"
    const pending = blockers().length
    // Without Voice mode (another harness's spoke), Voice on/off means nothing here.
    if (!controls().voice) return pending ? `${pending} request${pending === 1 ? "" : "s"} waiting` : `${controls().harnessName} session`
    const agent = voiceHere() && vs().agent ? `${vs().agent} agent` : s.conversation ? "Voice agent" : "Session agent"
    return `${agent} · ${pending ? `${pending} request${pending === 1 ? "" : "s"} waiting` : exposed() ? "Voice on" : "Voice off"}`
  }
  const changedFiles = () => summary()?.changes?.files.map((f) => f.file) ?? []

  return (
    <div class={`session-layout${railOpen() ? " with-rail" : ""}`}>
      <div class="session-main">
        <header class="topbar">
          <Show when={isPhone()}>
            <IconButton icon="menu" label="Open sidebar" onClick={toggleSidebar} />
          </Show>
          <div class="topbar-title">
            <Show when={parent()}>
              {(p) => (
                <a class="crumb muted" href={sessionHref(p().id)} title={`Back to ${p().title}`} aria-label={`Back to ${p().title}`}>
                  <Icon name="chevron" class="crumb-chev" /> {p().title}
                  <span class="crumb-sep" aria-hidden="true">/</span>
                </a>
              )}
            </Show>
            <Show when={row()} fallback={<h1 class="title">{found()?.session.title || (hub.machines ? "Session" : "Loading…")}</h1>}>
              {(r) => (
                <>
                  <StatusIcon state={r().state} />
                  <RenameTitle id={r().id} title={r().title} place="topbar" class="title">
                    <h1 class="title">
                      <button type="button" class="title-btn" title={`${r().title} · click to rename`} onClick={() => setRenaming({ id: r().id, place: "topbar" })}>
                        {r().title}
                      </button>
                    </h1>
                  </RenameTitle>
                  <Naming id={r().id} />
                  <Menu label="Session actions" class="icon-btn small" items={() => sessionMenu(r(), { open: false, place: "topbar" })} />
                </>
              )}
            </Show>
          </div>
          <Show when={found()}>
            {(f) => (
              <span class="chip-server" title={`${f().machine.name}${summary()?.branch ? ` · ${summary()!.branch}` : ""} · ${f().session.directory}`}>
                <span class={`online-dot${f().machine.online ? " on" : ""}`} aria-hidden="true" />
                {f().machine.name}
                <Show when={summary()?.branch}>
                  <Icon name="branch" />
                  {summary()!.branch}
                </Show>
              </span>
            )}
          </Show>
          <Show when={badge()}>
            {(b) => (
              <span class={`chip-evidence ${b().level}`} data-evidence={b().level} title={b().detail} aria-label={`${controls().harnessName} · evidence: ${b().label}. ${b().detail}`}>
                {controls().harnessName} · {b().label}
              </span>
            )}
          </Show>
          <Show when={summary()?.changes?.files.length}>
            <button type="button" class="btn small changes" onClick={() => setDiffFile(changedFiles()[0])} aria-label="Show changes">
              <span class="add">+{summary()!.changes!.additions}</span> <span class="del">−{summary()!.changes!.deletions}</span>
            </button>
          </Show>
          <Show when={voiceElsewhere()}>
            <VoicePill />
          </Show>
          <IconButton icon="rail" label={railOpen() ? "Hide details" : "Show details"} aria-pressed={railOpen()} onClick={() => setRailOpen(!railOpen())} />
        </header>

        <Show when={failure()}>
          {(e) => (
            <div class="banner session-error" role="alert" data-error-session={e().sessionID}>
              <span class="session-error-mark" aria-hidden="true">✕</span>
              <div class="session-error-body">
                <div class="session-error-head">
                  <strong>{e().label}</strong>
                  <Show when={e().status}>
                    <span class="session-error-status">{e().status}</span>
                  </Show>
                  <Show when={e().sessionID !== id && e().title}>
                    <span class="session-error-where muted">in subagent {e().title}</span>
                  </Show>
                </div>
                <Show when={e().message && e().message !== e().label}>
                  <div class="session-error-message">{e().message}</div>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={offline() && hub.machines}>
          <div class="banner warn">No connected OpenCode process reports this session. It is read-only until its machine reconnects.</div>
        </Show>

        <div class="scroller" ref={scroller} onScroll={(e) => (stick = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80)}>
          <div class="column">
            <Show when={!notFound()} fallback={<NotFound />}>
              <Show when={loaded()} fallback={<p class="muted pad">Loading conversation…</p>}>
                <Show when={noTimeline()}>
                  <p class="muted pad no-timeline" data-unavailable="timeline">
                    The hub can't show this {controls().harnessName} session's transcript; follow it in its terminal. Hub messages and live activity still appear here.
                  </p>
                </Show>
                <Show when={blocks().length || notes().length} fallback={<Show when={!noTimeline()}><p class="muted pad empty-session">No messages yet. Type below, or start Voice mode.</p></Show>}>
                  <div ref={setSentinel} class="history-sentinel" aria-hidden="true" />
                  <Switch>
                    <Match when={history().state === "loading"}>
                      <p class="history-edge loading muted small" role="status">
                        <span class="spinner small" /> Loading earlier messages…
                      </p>
                    </Match>
                    <Match when={history().state === "done" && blocks().length}>
                      <p class="history-edge muted small">Beginning of conversation</p>
                    </Match>
                    <Match when={history().state === "error"}>
                      <p class="history-edge error small" role="alert">
                        Couldn't load earlier messages: {history().error}{" "}
                        <button type="button" class="btn small" onClick={() => void pager.retry()}>
                          Retry
                        </button>
                      </p>
                    </Match>
                  </Switch>
                  <Transcript
                    sessionID={id}
                    blocks={blocks()}
                    ticks={ticks()}
                    expanded={expanded}
                    onToggle={(key, open) => setExpanded(key, open)}
                    onDetail={(key, detail) => {
                      timeline.detail(key, detail)
                      bump()
                    }}
                  />
                </Show>
              </Show>
              <For each={notes()}>{(n) => <p class={`note ${n.kind}`} role={n.kind === "err" ? "alert" : undefined}>{n.text}</p>}</For>
              {/* Keyed by request ID: catalog updates rebuild the blocker objects, which must not reset half-filled answers. */}
              <DecisionCards decisions={decisionsFor(decisions(), id)} />
              <For each={blockerIDs()}>{(key) => <Show when={blockerByID().get(key)}>{(b) => <BlockerCard sessionID={id} blocker={b()} rootID={id} canAnswer={b().kind === "permission" ? controls().permission : controls().form} harnessName={controls().harnessName} />}</Show>}</For>
              {/* Who answered this tree's requests lately (live 'agent' events), once their cards are gone. */}
              <For each={answeredNotes()}>
                {(n) => (
                  <p class="answered-by small muted" data-answered-by={n.key}>
                    {n.text}
                  </p>
                )}
              </For>
              <Show when={working()}>
                <p class="working-line muted" role="status">
                  <span class="spinner small" /> {working()}
                </p>
              </Show>
              <Show when={!running() && found() && row()}>
                <p class="idle-line muted small">
                  {STATE_LABEL[row()!.state]} · last activity {ago(row()!.updated, now())}
                </p>
              </Show>
            </Show>
          </div>
        </div>

        <div class="dock">
          <div class="column">
            <Show when={voiceHere()}>
              <VoiceBar
                state={vs().voice}
                level={vs().level}
                held={vs().held}
                ignored={vs().ignored}
                working={running()}
                model={modelLabel(models.prefs(), "voice")}
                onMute={() => voice.mute()}
                onEnd={() => void voice.end()}
                onModel={() => setPicker("voice")}
                notifyHint={voiceNotifyHint()}
                onAllowNotifications={() => void allowVoiceNotifications()}
                timing={vs().timing}
                detector={vs().detector}
              />
            </Show>
            <Show when={voiceNeedsTap()}>
              <button type="button" class="btn primary tap-to-start" onClick={() => void toggleVoice()}>
                Tap to start Voice mode
              </button>
            </Show>
            <Show when={voiceError()}>
              <p class="note err voice-error" role="alert">
                Voice mode: {voiceError()}
              </p>
            </Show>
            <Show
              when={gate().show}
              fallback={
                <div class="composer-unavailable" data-no-prompt>
                  <p class="muted small">{gate().hint}</p>
                  <Show when={view().showStop}>
                    <button type="button" class="btn stop" disabled={!view().canStop} onClick={() => void stop()} aria-label="Stop the session and its subagents">
                      <Icon name="stop" /> Stop
                    </button>
                  </Show>
                </div>
              }
            >
            <Composer
              draft={composer().draft}
              images={composer().images}
              attaching={attaching()}
              view={view()}
              error={composer().error}
              voiceOn={voiceHere()}
              voiceBlocked={voiceBlocked()}
              dictating={dictated().recording}
              transcribing={dictated().transcribing}
              metaLeft={metaLeft()}
              voiceModel={models.error() ? "unavailable" : modelLabel(models.prefs(), "voice")}
              workerModel={models.error() ? "unavailable" : modelLabel(models.prefs(), "worker")}
              onInput={(text) => act({ type: "input", text })}
              onAttach={attach}
              onDetach={(imageID) => {
                const image = composer().images.find((i) => i.id === imageID)
                if (image?.preview.startsWith("blob:")) URL.revokeObjectURL(image.preview)
                act({ type: "detach", id: imageID })
              }}
              onSubmit={() => void submit()}
              onStop={() => void stop()}
              onDictate={() => void dictate()}
              onVoice={() => void toggleVoice()}
              onModel={(kind) => setPicker(kind)}
              showModels={controls().models}
              showVoice={controls().voice}
            />
            </Show>
          </div>
        </div>

        <Show when={diffFile()}>
          <DiffPanel sessionID={id} file={diffFile()!} files={changedFiles().length ? changedFiles() : [diffFile()!]} onFile={setDiffFile} onClose={() => setDiffFile(undefined)} />
        </Show>
      </div>

      <Show when={railOpen()}>
        <Show when={isPhone()}>
          <div class="sheet-backdrop" onClick={() => setRailOpen(false)} />
        </Show>
        <Show when={!isPhone()}>
          <PanelHandle panel="rail" label="Resize details" />
        </Show>
        <Rail found={found()} summary={summary()} summaryError={summaryError()} loading={summaryLoading()} onFile={(f) => setDiffFile(f)} onClose={() => setRailOpen(false)} />
      </Show>
      <ModelPicker kind={picker()} models={models} onClose={() => setPicker(undefined)} />
    </div>
  )
}

function NotFound() {
  return (
    <div class="empty">
      <p class="display">Session not found</p>
      <p class="muted">It may belong to another account, or it no longer exists.</p>
      <a class="btn primary" href="/">
        Back to sessions
      </a>
    </div>
  )
}
