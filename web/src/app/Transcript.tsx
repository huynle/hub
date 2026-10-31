// The conversation column: user pills, assistant markdown, folded thoughts and tool groups (full tool details
// load on demand), subagent rows linking to the child session, failed turns ("Quota exceeded") and model retries
// with a live countdown. Provider text renders as text only.
import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { TimelineRow } from "../core/timeline-core"
import { formatElapsed } from "../core/feedback-core"
import { retryView, thoughtView, type Block, type BlockImage } from "../lib/transcript"
import { errorText, getJSON, sessionPath, enc } from "./api"
import { Markdown } from "./Markdown"
import { sessionHref } from "./router"
import { Icon, nowSecond } from "./ui"

export type TickState = "pending" | "sent" | "queued" | "heard" | "failed"
const TICK: Record<TickState, [string, string]> = {
  pending: ["…", "Sending"],
  sent: ["✓", "Sent"],
  queued: ["◷", "Queued: the harness takes it at its next step"],
  heard: ["✓✓", "Heard by the agent"],
  failed: ["!", "Not sent"],
}

interface Expansion {
  expanded: Readonly<Record<string, boolean>>
  onToggle: (key: string, open: boolean) => void
}

/** A thumbnail that opens the full image; a named chip for other files or when the image cannot load. */
function MessageImage(props: { image: BlockImage }) {
  const [failed, setFailed] = createSignal(false)
  return (
    <Show
      when={props.image.src && !failed()}
      fallback={
        <span class="file-chip" title={props.image.mime}>
          <Icon name="file" /> {props.image.name}
        </span>
      }
    >
      <a class="msg-image" href={props.image.src} target="_blank" rel="noopener" title={props.image.name}>
        <img src={props.image.src} alt={props.image.name} loading="lazy" onError={() => setFailed(true)} />
      </a>
    </Show>
  )
}

export function Transcript(props: { sessionID: string; blocks: Block[]; ticks: Record<string, TickState>; onDetail: (key: string, detail: unknown) => void } & Expansion) {
  return (
    <div class="transcript" aria-label="Conversation">
      <For each={props.blocks}>
        {(b) => (
          <Switch>
            <Match when={b.type === "user" && b}>
              {(u) => (
                <div class="msg user" data-key={u().key}>
                  <div class="user-body">
                    <Show when={u().images?.length}>
                      <div class="msg-images">
                        <For each={u().images}>{(image) => <MessageImage image={image} />}</For>
                      </div>
                    </Show>
                    <Show when={u().text}>
                      <div class="pill">{u().text}</div>
                    </Show>
                  </div>
                  <Show when={props.ticks[u().key]}>
                    {(t) => (
                      <span class={`tick ${t()}`} aria-label={TICK[t()][1]} title={TICK[t()][1]}>
                        {TICK[t()][0]}
                      </span>
                    )}
                  </Show>
                </div>
              )}
            </Match>
            <Match when={b.type === "assistant" && b}>
              {(a) => (
                <div class={`msg assistant${a().live ? " live" : ""}`} data-key={a().key}>
                  <Markdown text={a().text} streaming={a().live} />
                </div>
              )}
            </Match>
            <Match when={b.type === "thought" && b}>{(t) => <Thought block={t()} expanded={props.expanded} onToggle={props.onToggle} />}</Match>
            <Match when={b.type === "tools" && b}>{(t) => <Tools block={t()} sessionID={props.sessionID} onDetail={props.onDetail} expanded={props.expanded} onToggle={props.onToggle} />}</Match>
            <Match when={b.type === "message" && b}>{(m) => <HubMessage block={m()} expanded={props.expanded} onToggle={props.onToggle} />}</Match>
            <Match when={b.type === "error" && b}>
              {(e) => (
                <div class="msg turn-error" data-key={e().key} role="group" aria-label={`Error: ${e().label}`}>
                  <span class="turn-error-mark" aria-hidden="true">✕</span>
                  <div class="turn-error-body">
                    <div class="turn-error-head">
                      <strong class="turn-error-label">{e().label}</strong>
                      <Show when={e().status}>
                        <span class="turn-error-status">{e().status}</span>
                      </Show>
                    </div>
                    <Show when={e().message}>
                      <div class="turn-error-message">{e().message}</div>
                    </Show>
                  </div>
                </div>
              )}
            </Match>
            <Match when={b.type === "retry" && b}>
              {(r) => {
                const view = () => retryView(r(), nowSecond())
                return (
                  <p class={`msg turn-retry${view().waiting ? " waiting" : ""}`} data-key={r().key}>
                    <span class="turn-retry-mark" aria-hidden="true">↻</span>
                    <span>{view().text}</span>
                  </p>
                )
              }}
            </Match>
            <Match when={b.type === "subagent" && b}>
              {(s) => (
                <a class={`subagent ${s().state}`} href={sessionHref(s().sessionID)} data-key={s().key}>
                  <span class="sub-mark" aria-hidden="true">
                    {s().state === "working" ? <span class="spinner" /> : "◆"}
                  </span>
                  <span class="sub-label">
                    Subagent · <strong>{s().label}</strong>
                  </span>
                  <span class="sub-state muted">{s().state}</span>
                  <Icon name="chevron" class="chev" />
                </a>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  )
}

/** A hub message: "from @y" / "to @@r (→ @x)" over its text; the identity primer folds into one line. */
function HubMessage(props: { block: Extract<Block, { type: "message" }> } & Expansion) {
  const open = () => !!props.expanded[props.block.key]
  return (
    <Show
      when={!props.block.primer}
      fallback={
        <div class="fold hub-note" data-key={props.block.key}>
          <button type="button" class="fold-head" aria-expanded={open()} onClick={() => props.onToggle(props.block.key, !open())}>
            <span class="hub-msg-mark" aria-hidden="true">⇄</span>
            <span>{props.block.label}</span>
            <Icon name="chevron" class="chev" />
          </button>
          <Show when={open()}>
            <div class="fold-body hub-msg-text">{props.block.text}</div>
          </Show>
        </div>
      }
    >
      <div class={`msg hub-msg ${props.block.direction}`} data-key={props.block.key} role="group" aria-label={`Hub ${props.block.kind} ${props.block.label}`}>
        <div class="hub-msg-head">
          <span class="hub-msg-mark" aria-hidden="true">{props.block.direction === "out" ? "↗" : "↘"}</span>
          <Show when={props.block.kind !== "msg"}>
            <span class="hub-msg-kind">{props.block.kind}</span>
          </Show>
          <span class="hub-msg-label">{props.block.label}</span>
          <Show when={props.block.state === "open" || props.block.state === "answered" || props.block.state === "declined" || props.block.state === "expired"}>
            <span class="hub-msg-state muted">{props.block.state}</span>
          </Show>
          <Show when={props.block.delivery}>
            <span class="hub-msg-delivery muted" data-delivery={props.block.delivery} title="Not delivered into a turn yet: the recipient's harness takes it at its next step">
              {props.block.delivery}
            </span>
          </Show>
        </div>
        <div class="hub-msg-text">{props.block.text}</div>
      </div>
    </Show>
  )
}

function Thought(props: { block: Extract<Block, { type: "thought" }> } & Expansion) {
  const open = () => !!props.expanded[props.block.key]
  const setOpen = (on: boolean) => props.onToggle(props.block.key, on)
  const view = () => thoughtView(props.block)
  return (
    <div class="fold thought" data-key={props.block.key}>
      <button type="button" class="fold-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={props.block.running}>
          <span class="spinner small" />
        </Show>
        <span>{view().label}</span>
        <Icon name="chevron" class="chev" />
      </button>
      <Show when={open()}>
        <div class={`fold-body reasoning${view().muted ? " hidden-reasoning" : ""}`}>{view().body}</div>
      </Show>
    </div>
  )
}

function Tools(props: { block: Extract<Block, { type: "tools" }>; sessionID: string; onDetail: (key: string, detail: unknown) => void } & Expansion) {
  const open = () => !!props.expanded[props.block.key]
  const setOpen = (on: boolean) => props.onToggle(props.block.key, on)
  const n = () => props.block.items.length
  const label = () => {
    const b = props.block
    if (b.running) return `Using ${n() === 1 ? b.items[0]!.name ?? "a tool" : `${n()} tools`}…`
    return `Used ${n()} tool${n() === 1 ? "" : "s"}${b.failed ? ` (${b.failed} failed)` : ""}`
  }
  return (
    <div class={`fold tools${props.block.failed ? " has-failed" : ""}`} data-key={props.block.key}>
      <button type="button" class="fold-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={props.block.running}>
          <span class="spinner small" />
        </Show>
        <span>{label()}</span>
        <Icon name="chevron" class="chev" />
      </button>
      <Show when={open()}>
        <ul class="fold-body tool-list">
          <For each={props.block.items}>{(row) => <ToolRow row={row} sessionID={props.sessionID} onDetail={props.onDetail} expanded={props.expanded} onToggle={props.onToggle} />}</For>
        </ul>
      </Show>
    </div>
  )
}

function ToolRow(props: { row: TimelineRow; sessionID: string; onDetail: (key: string, detail: unknown) => void } & Expansion) {
  const open = () => !!props.expanded[`tool:${props.row.key}`]
  const setOpen = (on: boolean) => props.onToggle(`tool:${props.row.key}`, on)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const r = () => props.row
  const duration = () => (r().completed && r().at ? formatElapsed((r().completed as number) - (r().at as number)) : "")
  const toggle = async () => {
    const next = !open()
    setOpen(next)
    if (!next || r().detail !== undefined || !r().messageID || r().partID === undefined) return
    setLoading(true)
    setError("")
    try {
      const answer = await getJSON(`${sessionPath(props.sessionID)}/timeline/messages/${enc(r().messageID!)}/parts/${enc(String(r().partID))}`)
      props.onDetail(r().key, answer.detail)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  const summary = () => (typeof r().summary === "string" ? (r().summary as string) : "")
  return (
    <li class={`tool ${r().state ?? ""}`}>
      <button type="button" class="tool-head" aria-expanded={open()} onClick={toggle}>
        <span class="tool-mark" aria-label={r().state ?? ""}>
          {r().state === "running" ? <span class="spinner small" /> : r().state === "failed" ? "✕" : "✓"}
        </span>
        <span class="tool-name">{r().name ?? "tool"}</span>
        <span class="tool-summary muted">{summary()}</span>
        <span class="tool-time muted">{duration()}</span>
      </button>
      <Show when={open()}>
        <div class="tool-detail">
          <Show when={!loading()} fallback={<span class="muted small">Loading full details…</span>}>
            <Show when={!error()} fallback={<span class="error small">{error()}</span>}>
              <pre class="code">{JSON.stringify(r().detail ?? { summary: summary() || undefined, error: r().error }, null, 2)}</pre>
            </Show>
          </Show>
        </div>
      </Show>
    </li>
  )
}
