// Inline cards for what a session waits on: a permission (Allow once / Always / Deny) or a form from the agent
// (the question tool or any OpenCode form), answered here with its fields; both go away when answered anywhere.
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { Blocker } from "../core/browser-core"
import { formAnswer, initialFormValues, validateForm, visibleFields, type FormField, type FormValues } from "../core/form-core"
import { api, errorText, HttpError, sessionPath } from "./api"
import { toast } from "./toast"

/** A request someone answered elsewhere (terminal, another device) or that expired: say so quietly. */
function settled(e: unknown, hide: () => void): boolean {
  if (!(e instanceof HttpError) || e.status !== 409 || e.code !== "gone") return false
  toast("Already answered or expired")
  hide()
  return true
}

export function BlockerCard(props: { sessionID: string; rootID: string; blocker: Blocker }) {
  const [gone, setGone] = createSignal(false)
  const b = () => props.blocker
  const who = () => (b().sessionID && b().sessionID !== props.rootID ? ` (${b().sessionTitle || "subagent"})` : "")
  const label = () => (b().kind === "permission" ? "Permission request" : "Question")
  return (
    <Show when={!gone()}>
      <div class={`card blocker ${b().kind}`} role="group" aria-label={`${label()}: ${b().summary}`}>
        <p class="blocker-head">
          <strong>{b().kind === "permission" ? "Permission" : b().question ? "Question" : "Form"}</strong>
          {who()}
        </p>
        <Switch fallback={<p class="muted small">This question has nothing to fill in here; answer it in the terminal.</p>}>
          <Match when={b().kind === "permission"}>
            <p class="blocker-text mono">{b().summary}</p>
            <PermissionButtons sessionID={props.sessionID} blocker={b()} onGone={() => setGone(true)} />
          </Match>
          <Match when={b().kind === "form" && b().fields?.length}>
            <Show when={!b().question || b().summary !== "Questions"}>
              <p class="blocker-text">{b().summary}</p>
            </Show>
            <FormFields sessionID={props.sessionID} blocker={b()} fields={b().fields as FormField[]} onGone={() => setGone(true)} />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

function PermissionButtons(props: { sessionID: string; blocker: Blocker; onGone: () => void }) {
  const [busy, setBusy] = createSignal(false)
  const answer = async (decision: "once" | "always" | "reject") => {
    setBusy(true)
    try {
      await api(`${sessionPath(props.sessionID)}/permission`, { method: "POST", json: { requestID: props.blocker.id, decision } })
      toast(decision === "reject" ? "Denied" : "Allowed")
    } catch (e) {
      if (!settled(e, props.onGone)) toast(errorText(e), "err")
      setBusy(false)
    }
  }
  return (
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
  )
}

function FormFields(props: { sessionID: string; blocker: Blocker; fields: FormField[]; onGone: () => void }) {
  const [values, setValues] = createSignal<FormValues>(initialFormValues(props.fields))
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [sent, setSent] = createSignal(false)
  // Field keys, not field objects: live updates hand in fresh objects for the same fields, which must not
  // re-create the inputs (that drops focus and typed text).
  const shown = createMemo((prev: string[] = []) => {
    const next = visibleFields(props.fields, values()).map((f) => f.key)
    return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next
  })
  const field = (key: string) => props.fields.find((f) => f.key === key)
  const set = (key: string, value: FormValues[string]) => {
    setValues((v) => ({ ...v, [key]: value }))
    if (errors()[key]) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)))
  }
  const post = async (json: Record<string, unknown>, done: string) => {
    setBusy(true)
    try {
      await api(`${sessionPath(props.sessionID)}/form`, { method: "POST", json: { formID: props.blocker.id, ...json } })
      setSent(true)
      toast(done)
    } catch (e) {
      if (!settled(e, props.onGone)) toast(errorText(e), "err")
      setBusy(false)
    }
  }
  const submit = (event: Event) => {
    event.preventDefault()
    const problems = validateForm(props.fields, values())
    setErrors(problems)
    if (Object.keys(problems).length) return
    const answer = formAnswer(props.fields, values())
    // An all-empty answer reaches OpenCode as "Unanswered" for every question: almost always a lost or missed
    // selection, never what Submit means (Dismiss skips the questions).
    if (props.blocker.question && !Object.values(answer).some((v) => (Array.isArray(v) ? v.length > 0 : v !== "" && v !== false))) {
      toast("Pick or type an answer first (Dismiss skips the questions)", "err")
      return
    }
    void post({ answer }, "Answer sent")
  }
  const disabled = () => busy() || sent()
  return (
    <form class="form-card" onSubmit={submit} novalidate>
      <fieldset disabled={disabled()}>
        <For each={shown()}>
          {(key) => (
            <Show when={field(key)}>
              {(f) => (
                <div class={`form-field ${f().type}`} data-key={key}>
                  <FieldInput field={f()} value={values()[key]} onChange={(v) => set(key, v)} formID={props.blocker.id} />
                  <Show when={errors()[key]}>
                    <p class="field-error small" role="alert">
                      {errors()[key]}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
          )}
        </For>
        <div class="row">
          <button type="submit" class="btn small primary">
            {sent() ? "Sent" : "Submit"}
          </button>
          <button type="button" class="btn small" onClick={() => void post({ cancel: true }, "Dismissed")}>
            Dismiss
          </button>
        </div>
      </fieldset>
    </form>
  )
}

function FieldInput(props: { field: FormField; value: FormValues[string] | undefined; onChange: (value: FormValues[string]) => void; formID: string }) {
  const f = () => props.field
  const id = () => `f-${props.formID}-${f().key}`
  const title = () => f().title || f().key
  const text = () => (typeof props.value === "string" ? props.value : "")
  const list = () => (Array.isArray(props.value) ? props.value : [])
  const optionValues = () => new Set((f().options ?? []).map((o) => o.value))
  const Legend = () => (
    <>
      <span class="field-title">
        {title()}
        {f().required ? " *" : ""}
      </span>
      <Show when={f().description}>
        <span class="field-desc muted small">{f().description}</span>
      </Show>
    </>
  )
  return (
    <Switch>
      <Match when={f().type === "external"}>
        <Legend />
        <a class="btn small" href={f().url} target="_blank" rel="noopener noreferrer">
          Open link
        </a>
      </Match>
      <Match when={f().type === "boolean"}>
        <label class="check">
          <input type="checkbox" checked={props.value === true} onChange={(e) => props.onChange(e.currentTarget.checked)} />
          <Legend />
        </label>
      </Match>
      <Match when={f().type === "multiselect"}>
        <div role="group" aria-label={title()} class="choice-group">
          <Legend />
          <For each={f().options ?? []}>
            {(o) => (
              <label class="choice">
                <input
                  type="checkbox"
                  checked={list().includes(o.value)}
                  onChange={(e) => props.onChange(e.currentTarget.checked ? [...list(), o.value] : list().filter((x) => x !== o.value))}
                />
                <span>{o.label}</span>
                <Show when={o.description}>
                  <span class="muted small"> — {o.description}</span>
                </Show>
              </label>
            )}
          </For>
          <Show when={f().custom}>
            <input
              type="text"
              aria-label={`${title()}: other`}
              placeholder="Other (comma separated)"
              value={list().filter((x) => !optionValues().has(x)).join(", ")}
              onChange={(e) =>
                props.onChange([
                  ...list().filter((x) => optionValues().has(x)),
                  ...e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean),
                ])
              }
            />
          </Show>
        </div>
      </Match>
      <Match when={f().type === "string" && f().options?.length}>
        <div role="radiogroup" aria-label={title()} class="choice-group">
          <Legend />
          <For each={f().options ?? []}>
            {(o) => (
              <label class="choice">
                <input type="radio" name={id()} checked={text() === o.value} onChange={() => props.onChange(o.value)} />
                <span>{o.label}</span>
                <Show when={o.description}>
                  <span class="muted small"> — {o.description}</span>
                </Show>
              </label>
            )}
          </For>
          <Show when={f().custom}>
            <input
              type="text"
              aria-label={`${title()}: your own answer`}
              placeholder="Type your own answer"
              value={optionValues().has(text()) ? "" : text()}
              onInput={(e) => props.onChange(e.currentTarget.value)}
            />
          </Show>
        </div>
      </Match>
      <Match when={true}>
        <label class="text-field" for={id()}>
          <Legend />
        </label>
        <input
          id={id()}
          type="text"
          inputmode={f().type === "number" || f().type === "integer" ? "decimal" : undefined}
          placeholder={f().placeholder ?? ""}
          value={text()}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
      </Match>
    </Switch>
  )
}
