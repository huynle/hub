// One session: top bar, transcript (history + live), permission/question cards, Voice bar, composer, right rail
// and diff viewer. Works whether Voice is on or off; Voice mode turns Voice on first when needed.
import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { blockersOf, type Blocker } from "../core/browser-core"
import { reconcileSay, statusNotes, type StatusLike } from "../core/conversation-core"
import { speechSetup, type StatusEntry } from "../core/feedback-core"
import { Timeline } from "../core/timeline-core"
import { composerReducer, composerView, initialComposer, type ComposerAction } from "../lib/composer"
import { treeRunning } from "../lib/store"
import { transcriptBlocks, type Block } from "../lib/transcript"
import { createStore } from "solid-js/store"
import { Conversation, type ConversationState } from "../voice/conversation"
import { micDevice, player, unlockAudio, voicePrefs } from "../voice/audio"
import { sessionMenu } from "./actions"
import { api, errorText, getJSON, HttpError, sessionPath } from "./api"
import { prepareImage } from "./attach"
import { Composer, VoiceBar } from "./Composer"
import { hub, live, liveTick, lookup, markRead, me, onMessage, rows, setVoice, speechReady } from "./hub"
import { isPhone, railOpen, setRailOpen, toggleSidebar } from "./layout"
import { ModelPicker, createModels, modelLabel, type ModelKind } from "./ModelMenu"
import { DiffPanel, Rail, type Summary } from "./Rail"
import { navigate } from "./router"
import { toast } from "./toast"
import { dictation, dictationFor, drafts } from "./voice"
import { Transcript, type TickState } from "./Transcript"
import { Icon, IconButton, Menu, STATE_LABEL, StatusIcon, ago, now } from "./ui"
import { formatElapsed } from "../core/feedback-core"

const PRESENCE_MS = 30_000
const SUMMARY_THROTTLE_MS = 2000

export function SessionView(props: { id: string }) {
  const id = props.id
  const found = () => lookup(id)
  const row = () => rows().find((r) => r.id === id)
  const status = () => found()?.session.status as readonly StatusEntry[] | undefined
  const running = () => treeRunning(status())
  const offline = () => !found()
  const exposed = () => found()?.session.exposed !== false

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

  async function loadTimeline() {
    try {
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await getJSON(`${sessionPath(id)}/timeline?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        timeline.load(page.items)
        cursor = page.cursor
        pages++
      } while (cursor && pages < 10)
      setLoaded(true)
      bump()
      toEnd()
    } catch (e) {
      if (e instanceof HttpError && e.status === 404 && !found()) setNotFound(true)
      else note(e instanceof HttpError && e.status === 409 ? "No OpenCode process for this session is connected; history is unavailable until it reconnects." : `Could not load the conversation: ${errorText(e)}`, "err")
      setLoaded(true)
    }
  }

  async function loadBacklog() {
    try {
      const info = await getJSON(sessionPath(id))
      const feed = live.feed(id)
      feed.load(info.activity ?? [])
      if (info.status) feed.status(info.status)
    } catch {
      // live events fill the feed
    }
  }

  // ---------- live messages ----------
  let lastStatus: readonly StatusLike[] | undefined = untrack(() => status() as readonly StatusLike[] | undefined)
  const unsubscribe = onMessage((m) => {
    const rootID = typeof m.rootID === "string" ? m.rootID : m.sessionID
    if (m.type === "activity" && rootID === id && m.item && m.item.kind !== "thinking") {
      // Tool steps; thinking shows up through streamed reasoning.
      const item = m.item
      timeline.upsert({
        key: `activity:${m.sessionID}:${item.id}`,
        sessionID: m.sessionID,
        kind: "tool",
        ...(item.tool ? { name: item.tool } : {}),
        ...(item.summary ? { summary: item.summary } : {}),
        ...(item.error ? { error: item.error } : {}),
        state: item.state,
        at: timeline.get(`activity:${m.sessionID}:${item.id}`)?.at ?? item.at,
      })
      bump()
    } else if (m.type === "reasoning" && rootID === id && typeof m.messageID === "string" && typeof m.delta === "string") {
      timeline.appendReasoning({ sessionID: m.sessionID, messageID: m.messageID, delta: m.delta })
      bump()
    } else if (m.type === "delta" && rootID === id && typeof m.messageID === "string" && typeof m.text === "string") {
      const key = `${m.messageID}:text`
      timeline.upsert({
        key,
        messageID: m.messageID,
        sessionID: m.sessionID,
        kind: "assistant",
        text: `${timeline.get(key)?.text ?? ""}${m.text}`,
        live: true,
        at: timeline.get(key)?.at ?? Date.now(),
      })
      // Text after reasoning ends that reasoning.
      timeline.endReasoning(m.sessionID)
      bump()
    } else if (m.type === "status" && m.sessionID === id) {
      for (const text of statusNotes(lastStatus, m.sessions, id)) note(text, "sys")
      lastStatus = m.sessions
      if (!treeRunning(m.sessions)) {
        for (const r of timeline.rows()) if (r.live) timeline.upsert({ key: r.key, live: false } as never)
        timeline.endReasoning(undefined)
      }
      convo()?.onStatus(m.sessions)
      bump()
      scheduleSummary()
    } else if ((m.type === "say" || m.type === "heard" || m.type === "conversation") && m.sessionID === id) {
      convo()?.onEvent(m)
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
  const view = () => composerView(composer(), { running: running(), offline: offline() })
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
    const c = convo()
    // Voice mode speaks replies to utterances; a message with images goes as a typed turn instead.
    if (c && !images.length) {
      act({ type: "input", text: "" })
      void c.sendTyped(text)
      return
    }
    const sub = ++submitSeq
    const key = `local:${sub}`
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
      const res = await api(`${sessionPath(id)}/turn`, { method: "POST", json })
      const result = await res.json().catch(() => ({}))
      act({ type: "accepted", id: sub })
      setTicks((t) => ({ ...t, [key]: res.status === 202 ? "sent" : "heard" }))
      if (res.status === 202) toast("Steered the running session")
      else {
        const streamed = timeline.rows().some((r) => r.kind === "assistant" && (r.at ?? 0) >= sentAt && r.text)
        if (result.reply && !streamed) timeline.upsert({ key: `reply:${sub}`, kind: "assistant", text: result.reply, at: Date.now() })
        if (result.outcome === "timeout") note("The agent is still working; the reply may be partial.", "sys")
        else if (result.outcome && result.outcome !== "succeeded") note(`Turn ${result.outcome}${result.message ? `: ${result.message}` : ""}`, "err")
        bump()
      }
    } catch (e) {
      const message = e instanceof HttpError && e.status === 504 ? "OpenCode did not answer in time. The session may still be working." : errorText(e)
      batch(() => {
        act({ type: "rejected", id: sub, message })
        timeline.upsert({ key, kind: "user", text: "", images: [] })
        bump()
      })
    }
  }

  async function stop() {
    act({ type: "stop" })
    try {
      const { stopped } = await (await api(`${sessionPath(id)}/stop`, { method: "POST", json: {} })).json()
      const n = Array.isArray(stopped) ? stopped.length : 0
      toast(n ? `Stopped ${n} session${n === 1 ? "" : "s"}` : "Nothing was running")
    } catch (e) {
      toast(`Could not stop: ${errorText(e)}`, "err")
    } finally {
      act({ type: "stopped" })
    }
  }

  // ---------- dictation ----------
  // App-level: the text goes into this session's draft; leaving the session while recording cancels it.
  const dictated = () => dictationFor(id)
  const dictate = () => dictation.toggle(id)

  // ---------- Voice mode ----------
  const [convo, setConvo] = createSignal<Conversation<string> | undefined>()
  const [voiceState, setVoiceState] = createSignal<ConversationState>("off")
  const [level, setLevel] = createSignal(0)
  const [held, setHeld] = createSignal("")
  const voiceBlocked = () => {
    const setup = speechSetup(speechReady() ?? undefined, me()?.publicURL)
    return setup?.micBlocked ? "Set up speech in Settings to use the microphone" : undefined
  }

  async function toggleVoice() {
    const current = convo()
    if (current) return void current.stop()
    unlockAudio()
    if (!exposed()) {
      if (!(await setVoice(id, true))) return
      // Wait (briefly) for the catalog to report Voice on before starting.
      for (let i = 0; i < 25 && !exposed() && !disposed; i++) await new Promise((r) => setTimeout(r, 200))
    }
    // The user left this session meanwhile: never start a conversation nobody can see or stop.
    if (disposed) return
    const c = new Conversation<string>({
      sessionID: id,
      api,
      player,
      ui: {
        state: (name) => setVoiceState(name),
        level: (x) => setLevel(x),
        held: (text) => setHeld(text),
        user: (text) => {
          const key = `voice:${++localSeq}`
          timeline.upsert({ key, kind: "user", text, at: Date.now() })
          setTicks((t) => ({ ...t, [key]: "pending" }))
          bump()
          return key
        },
        tick: (key, kind) => setTicks((t) => ({ ...t, [key]: kind })),
        agent: (message) => {
          const key = message.messageID ? `${message.messageID}:text` : `say:${++localSeq}`
          const { mode, text } = reconcileSay(timeline.get(key)?.text ?? "", message.text)
          if (mode !== "keep") {
            timeline.upsert({ key, messageID: message.messageID, kind: "assistant", text, at: timeline.get(key)?.at ?? Date.now() })
            bump()
          }
        },
        note: (text, kind) => note(text, kind ?? "sys"),
        ended: () => {
          setConvo(undefined)
          setVoiceState("off")
        },
      },
      options: {
        cues: voicePrefs.cues,
        background: voicePrefs.background,
        speed: () => voicePrefs.speed,
        title: () => found()?.session.title || "OpenCode session",
        status: status(),
        deviceId: micDevice() || undefined,
      },
    })
    setConvo(c)
    const started = await c.start()
    if (!started) setConvo(undefined)
    else note(`Voice mode on${c.agent ? ` (${c.agent} agent)` : ""}. Speak naturally; say “stop” to interrupt, “pause listening” to end.`, "sys")
  }

  // ---------- lifecycle ----------
  onMount(() => {
    void loadTimeline()
    void loadBacklog()
    void loadSummary()
    void models.load()
    void markRead(id)
    void presence(document.visibilityState === "visible")
    presenceTimer = setInterval(() => document.visibilityState === "visible" && void presence(true), PRESENCE_MS)
    document.addEventListener("visibilitychange", onVisibility)
  })
  const leave = () => {
    convo()?.stop({ keepalive: true })
    void presence(false, true)
  }
  window.addEventListener("pagehide", leave)
  let disposed = false
  onCleanup(() => {
    disposed = true
    unsubscribe()
    clearInterval(presenceTimer)
    clearTimeout(summaryTimer)
    clearTimeout(readTimer)
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pagehide", leave)
    if (!player.paused) player.pause()
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
  const blockers = () => blockersOf(found()?.session)
  const pulse = () => {
    liveTick()
    now()
    return live.has(id) ? live.feed(id).pulse() : undefined
  }
  const [tick, setTick] = createSignal(Date.now())
  const ticker = setInterval(() => setTick(Date.now()), 1000)
  onCleanup(() => clearInterval(ticker))
  const working = () => {
    const p = pulse()
    if (!running() || !p?.busy) return undefined
    tick()
    return `${p.label}${p.since ? ` · ${formatElapsed(Date.now() - p.since)}` : ""}`
  }
  const metaLeft = () => {
    const s = found()?.session
    if (!s) return "Not connected"
    const pending = blockers().length
    const agent = convo()?.agent ? `${convo()!.agent} agent` : s.conversation ? "Voice agent" : "Session agent"
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
            <Show when={row()} fallback={<h1 class="title">{found()?.session.title || (hub.machines ? "Session" : "Loading…")}</h1>}>
              {(r) => (
                <>
                  <StatusIcon state={r().state} />
                  <h1 class="title" title={r().title}>
                    {r().title}
                  </h1>
                  <Menu label="Session actions" class="icon-btn small" items={() => sessionMenu(r(), { open: false })} />
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
          <Show when={summary()?.changes?.files.length}>
            <button type="button" class="btn small changes" onClick={() => setDiffFile(changedFiles()[0])} aria-label="Show changes">
              <span class="add">+{summary()!.changes!.additions}</span> <span class="del">−{summary()!.changes!.deletions}</span>
            </button>
          </Show>
          <IconButton icon="rail" label={railOpen() ? "Hide details" : "Show details"} aria-pressed={railOpen()} onClick={() => setRailOpen(!railOpen())} />
        </header>

        <Show when={offline() && hub.machines}>
          <div class="banner warn">No connected OpenCode process reports this session. It is read-only until its machine reconnects.</div>
        </Show>

        <div class="scroller" ref={scroller} onScroll={(e) => (stick = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80)}>
          <div class="column">
            <Show when={!notFound()} fallback={<NotFound />}>
              <Show when={loaded()} fallback={<p class="muted pad">Loading conversation…</p>}>
                <Show when={blocks().length || notes().length} fallback={<p class="muted pad empty-session">No messages yet. Type below, or start Voice mode.</p>}>
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
              <For each={blockers()}>{(b) => <BlockerCard sessionID={id} blocker={b} rootID={id} />}</For>
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
            <Show when={convo()}>
              <VoiceBar
                state={voiceState()}
                level={level()}
                held={held()}
                working={running()}
                model={modelLabel(models.prefs(), "voice")}
                onMute={() => (convo()!.paused ? convo()!.resume() : convo()!.pause())}
                onEnd={() => void convo()?.stop()}
                onModel={() => setPicker("voice")}
              />
            </Show>
            <Composer
              draft={composer().draft}
              images={composer().images}
              attaching={attaching()}
              view={view()}
              error={composer().error}
              voiceOn={!!convo()}
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
            />
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

/** Inline permission card (answerable without Voice) or a question to answer in the terminal. */
function BlockerCard(props: { sessionID: string; rootID: string; blocker: Blocker }) {
  const [busy, setBusy] = createSignal(false)
  const b = () => props.blocker
  const who = () => (b().sessionID && b().sessionID !== props.rootID ? ` (${b().sessionTitle || "subagent"})` : "")
  const answer = async (decision: "once" | "always" | "reject") => {
    setBusy(true)
    try {
      await api(`${sessionPath(props.sessionID)}/permission`, { method: "POST", json: { requestID: b().id, decision } })
      toast(decision === "reject" ? "Denied" : "Allowed")
    } catch (e) {
      toast(errorText(e), "err")
      setBusy(false)
    }
  }
  return (
    <div class={`card blocker ${b().kind}`} role="group" aria-label={`${b().kind === "permission" ? "Permission request" : "Question"}: ${b().summary}`}>
      <p class="blocker-head">
        <strong>{b().kind === "permission" ? "Permission" : "Question"}</strong>
        {who()}
      </p>
      <p class="blocker-text mono">{b().summary}</p>
      <Show when={b().kind === "permission"} fallback={<p class="muted small">Answer this one in the terminal; the hub cannot reply to questions yet.</p>}>
        <div class="row">
          <button type="button" class="btn small primary" disabled={busy()} onClick={() => void answer("once")}>
            Allow once
          </button>
          <button type="button" class="btn small" disabled={busy()} onClick={() => void answer("always")}>
            Always allow
          </button>
          <button type="button" class="btn small danger" disabled={busy()} onClick={() => void answer("reject")}>
            Deny
          </button>
        </div>
      </Show>
    </div>
  )
}
