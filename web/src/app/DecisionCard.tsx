// A Decision card (hub ask @me, design §12.1): the question, the options (the recommended one marked, with why;
// safe ones marked), urgency, the deadline countdown and the tier note; answered here with an option (and an
// optional note) or a text. The first answer anywhere wins: a later one gets 409 gone ("Already answered or
// expired"), and the card goes. A push tap opens /…?decision=<id>, which marks and scrolls to the card.
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { answerBody, askerLabel, deadlineText, tierNote, type DecisionView } from "../core/decision-core"
import { escalationOf } from "../core/agents-core"
import { api, enc, errorText, HttpError } from "./api"
import { dropDecision, lookup, settleDecision } from "./hub"
import { location$, sessionHref } from "./router"
import { toast } from "./toast"

const URGENCY_LABEL = { low: "Low urgency", normal: "", high: "Urgent" } as const

export function DecisionCard(props: { decision: DecisionView; /** Home: link to the session it concerns. */ showSession?: boolean }) {
  const d = () => props.decision
  const [picked, setPicked] = createSignal<string | undefined>()
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [tick, setTick] = createSignal(Date.now())
  const timer = setInterval(() => d().deadline !== undefined && setTick(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const targeted = () => location$().searchParams.get("decision") === d().id
  let el: HTMLDivElement | undefined
  onMount(() => {
    if (targeted()) el?.scrollIntoView({ block: "center" })
  })
  const session = () => (d().sessionID ? lookup(d().sessionID!) : undefined)
  const submit = async (event: Event) => {
    event.preventDefault()
    const result = answerBody(d(), picked(), note())
    if (!result.ok) {
      toast(result.problem, "err")
      return
    }
    setBusy(true)
    try {
      const res = await api(`/api/decisions/${enc(d().id)}/answer`, { method: "POST", json: result.body })
      const { decision } = (await res.json()) as { decision?: DecisionView }
      toast("Answer sent")
      if (decision) settleDecision(decision)
      else dropDecision(d().id)
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.code === "gone") {
        toast("Already answered or expired")
        dropDecision(d().id)
        return
      }
      toast(errorText(e), "err")
      setBusy(false)
    }
  }
  const recommended = (id: string) => d().recommendation?.option === id
  return (
    <div
      ref={el}
      class={`card decision urgency-${d().urgency}${targeted() ? " targeted" : ""}`}
      role="group"
      aria-label={`Decision: ${d().question}`}
      data-decision={d().id}
    >
      <p class="blocker-head decision-head">
        <strong>Decision</strong> <span class="muted">from {askerLabel(d())}</span>
        <Show when={escalationOf(d())}>
          <span class="badge-pill agent-request" title="An agent asked to act outside its grant">Agent request</span>
        </Show>
        <Show when={URGENCY_LABEL[d().urgency]}>
          <span class={`badge-pill urgency ${d().urgency}`}>{URGENCY_LABEL[d().urgency]}</span>
        </Show>
        <Show when={props.showSession && session()}>
          {(s) => (
            <>
              {" · "}
              <a href={sessionHref(s().session.id)}>{s().session.title || s().session.id}</a>
            </>
          )}
        </Show>
      </p>
      <p class="blocker-text decision-question">{d().question}</p>
      <Show when={escalationOf(d())}>
        {(e) => (
          <dl class="escalation-details small" data-escalation>
            <dt>Requested by</dt>
            <dd>{e().requester}</dd>
            <Show when={e().action}>
              <dt>Action</dt>
              <dd class="mono">
                {e().action}
                {e().always ? " (always)" : ""}
              </dd>
            </Show>
            <Show when={e().resources.length}>
              <dt>{e().resources.length === 1 ? "Resource" : "Resources"}</dt>
              <dd>
                <For each={e().resources}>{(r) => <code class="escalation-resource">{r}</code>}</For>
              </dd>
            </Show>
            <Show when={e().reason}>
              <dt>Outside its grant</dt>
              <dd>{e().reason}</dd>
            </Show>
          </dl>
        )}
      </Show>
      <Show when={deadlineText(d(), tick())}>
        <p class={`decision-deadline small${d().escalatedAt !== undefined || d().deadline! <= tick() ? " overdue" : ""}`} role="timer">
          {deadlineText(d(), tick())}
        </p>
      </Show>
      <form class="form-card" onSubmit={(e) => void submit(e)} novalidate>
        <fieldset disabled={busy()}>
          <Show
            when={d().options.length}
            fallback={
              <label class="text-field">
                <span class="field-title">Your answer</span>
                <textarea rows={2} aria-label="Your answer" value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
              </label>
            }
          >
            <div role="radiogroup" aria-label="Options" class="choice-group">
              <For each={d().options}>
                {(o) => (
                  <label class={`choice${recommended(o.id) ? " recommended" : ""}`}>
                    <input type="radio" name={`d-${d().id}`} value={o.id} checked={picked() === o.id} onChange={() => setPicked(o.id)} />
                    <span>{o.label}</span>
                    <Show when={o.safe}>
                      <span class="badge-pill safe" title="A timeout may pick this option">safe</span>
                    </Show>
                    <Show when={recommended(o.id)}>
                      <span class="badge-pill recommended">Recommended</span>
                    </Show>
                  </label>
                )}
              </For>
            </div>
            <Show when={d().recommendation?.why}>
              <p class="muted small decision-why">Why: {d().recommendation!.why}</p>
            </Show>
            <input type="text" class="decision-note" aria-label="Note (optional)" placeholder="Note (optional)" value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
          </Show>
          <Show when={tierNote(d())}>
            <p class="muted small decision-tier">{tierNote(d())}</p>
          </Show>
          <div class="row">
            <button type="submit" class="btn small primary">
              Answer
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  )
}

/** Cards keyed by Decision ID: an update (escalated) must not reset a half-made choice. */
export function DecisionCards(props: { decisions: readonly DecisionView[]; showSession?: boolean }) {
  const byID = createMemo(() => new Map(props.decisions.map((d) => [d.id, d])))
  const ids = createMemo((prev: string[] = []) => {
    const next = [...byID().keys()]
    return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
  })
  return <For each={ids()}>{(id) => <Show when={byID().get(id)}>{(d) => <DecisionCard decision={d()} showSession={props.showSession} />}</Show>}</For>
}
