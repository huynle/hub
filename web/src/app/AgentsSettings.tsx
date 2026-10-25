// Settings → Agents (design §5, §7; P3-T12): what agents may do for you. Grants (GET/POST /api/agent/grants, PUT and
// DELETE …/:id) with their state, holder, projects, verbs, never patterns and expiry countdown; the per-user acting
// switch (GET/PUT /api/agent/acting) and, for admins, the hub-wide one (GET/PUT /api/admin/agents/acting); and the
// Activity tab: the agent audit, a page at a time (GET /api/agent/audit?limit&before). Labels: core/agents-core.ts.
import { For, Show, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { isAdmin } from "../core/account-core"
import {
  GRANT_VERBS,
  actingView,
  auditLine,
  draftOf,
  grantBody,
  grantRow,
  hubErrorField,
  parseAuditPage,
  parseGrant,
  parseGrants,
  type AuditEntryView,
  type GrantDraft,
  type GrantField,
  type GrantView,
} from "../core/agents-core"
import { api, enc, errorText, getJSON, HttpError } from "./api"
import { agentEntries, me } from "./hub"
import { toast } from "./toast"
import { Dialog, ago, now } from "./ui"

const AUDIT_PAGE = 50
const GRANTS = "/api/agent/grants"

export function AgentsSection() {
  const [tab, setTab] = createSignal<"grants" | "activity">("grants")
  return (
    <section class="settings-section" id="agents" aria-labelledby="h-agents">
      <h2 id="h-agents">Agents</h2>
      <p class="small muted">
        What sessions and apps may do for you: approve, deny, answer, prompt or stop in your sessions, only within a grant. Anything outside a grant comes to you as a
        Decision.
      </p>
      <ActingSwitches />
      <div class="chips" role="group" aria-label="Agents sections">
        <button type="button" class="chip" aria-pressed={tab() === "grants"} onClick={() => setTab("grants")}>
          Grants
        </button>
        <button type="button" class="chip" aria-pressed={tab() === "activity"} onClick={() => setTab("activity")}>
          Activity
        </button>
      </div>
      <Show when={tab() === "grants"}>
        <Grants />
      </Show>
      <Show when={tab() === "activity"}>
        <Activity />
      </Show>
    </section>
  )
}

// ---------- switches ----------

function ActingSwitches() {
  const [acting, { mutate }] = createResource(() => getJSON("/api/agent/acting").then(actingView))
  const [hubSwitch, hubActions] = createResource(
    () => isAdmin(me()) || undefined,
    () => getJSON("/api/admin/agents/acting").then((r) => r?.enabled !== false),
  )
  const [busy, setBusy] = createSignal(false)
  const setMine = async (input: HTMLInputElement) => {
    const enabled = input.checked
    setBusy(true)
    try {
      mutate(actingView(await (await api("/api/agent/acting", { method: "PUT", json: { enabled } })).json()))
      toast(enabled ? "Agent actions are on for you" : "Agent actions are off for you")
    } catch (e) {
      input.checked = !enabled
      toast(errorText(e), "err")
    } finally {
      setBusy(false)
    }
  }
  const setHub = async (input: HTMLInputElement) => {
    const enabled = input.checked
    if (!enabled && !confirm("Turn agent actions off for everyone on this hub? No agent can act until an admin turns them on again.")) {
      input.checked = true
      return
    }
    setBusy(true)
    try {
      const res = await (await api("/api/admin/agents/acting", { method: "PUT", json: { enabled } })).json()
      hubActions.mutate(res?.enabled !== false)
      toast(enabled ? "Agent actions are on for this hub" : "Agent actions are off for this hub")
      const mine = await getJSON("/api/agent/acting").catch(() => undefined)
      if (mine) mutate(actingView(mine))
    } catch (e) {
      input.checked = !enabled
      toast(errorText(e), "err")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={acting()} fallback={<p class="small muted">{acting.error ? `Could not load: ${errorText(acting.error)}` : "Loading…"}</p>}>
      {(view) => (
        <>
          <ul class="switches">
            <li>
              <label class="switch">
                <span class="notify-kind">
                  <span>Agent actions</span>
                  <span class="small muted">Let agents act for you within their grants. Off: every agent action is refused (paused).</span>
                </span>
                <input type="checkbox" data-acting checked={view().on} disabled={busy()} onChange={(e) => void setMine(e.currentTarget)} />
              </label>
            </li>
            <Show when={isAdmin(me()) && hubSwitch() !== undefined}>
              <li>
                <label class="switch">
                  <span class="notify-kind">
                    <span>Agent actions on this hub</span>
                    <span class="small muted">Admin: the switch for every user of this hub.</span>
                  </span>
                  <input type="checkbox" data-hub-acting checked={hubSwitch()} disabled={busy()} onChange={(e) => void setHub(e.currentTarget)} />
                </label>
              </li>
            </Show>
          </ul>
          <Show when={view().note}>
            <p class="small warn" role="status" data-acting-note>
              {view().note}
            </p>
          </Show>
        </>
      )}
    </Show>
  )
}

// ---------- grants ----------

function Grants() {
  const [grants, { refetch, mutate }] = createResource(() => getJSON(GRANTS).then(parseGrants))
  const [editing, setEditing] = createSignal<GrantView | "new" | undefined>()
  const [clock, setClock] = createSignal(Date.now())
  const tick = setInterval(() => setClock(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))
  const revoke = async (g: GrantView) => {
    if (!confirm(`Revoke the grant of ${g.holder}? It stops at once.`)) return
    try {
      const res = await (await api(`${GRANTS}/${enc(g.id)}`, { method: "DELETE" })).json()
      const revoked = parseGrant(res?.grant)
      if (revoked) mutate((list) => (list ?? []).map((x) => (x.id === revoked.id ? revoked : x)))
      else void refetch()
      toast(`Grant of ${g.holder} revoked`)
    } catch (e) {
      toast(errorText(e), "err")
      void refetch()
    }
  }
  const saved = (g: GrantView) => {
    mutate((list) => [g, ...(list ?? []).filter((x) => x.id !== g.id)].sort((a, b) => b.created - a.created))
    setEditing(undefined)
  }
  return (
    <div class="stack">
      <div class="row">
        <p class="small muted grow">Each grant lets one holder (a session, a reserved role like @@orchestrator, or an app) act in some projects, for a while.</p>
        <button type="button" class="btn small primary" onClick={() => setEditing("new")}>
          New grant
        </button>
      </div>
      {/* Keyed: the dialog reads its grant once (an accessor would be read stale while the dialog closes). */}
      <Show when={editing()} keyed>
        {(which) => <GrantDialog grant={which === "new" ? undefined : which} onSaved={saved} onClose={() => setEditing(undefined)} />}
      </Show>
      <Show when={grants()} fallback={<p class="small muted">{grants.error ? `Could not load: ${errorText(grants.error)}` : "Loading…"}</p>}>
        <Show when={grants()!.length} fallback={<p class="small muted">No grants. Agents can still ask you (Decisions).</p>}>
          <ul class="list grants">
            <For each={grants()}>
              {(g) => {
                const row = () => grantRow(g, clock())
                return (
                  <li class={`grant-row${row().editable ? "" : " ended"}`} data-grant={g.id}>
                    <div class="grow">
                      <div class="name">
                        {row().holder}
                        <span class={`badge-pill ${row().state}`}>{row().stateLabel}</span>
                      </div>
                      <dl class="grant-facts small">
                        <dt>Projects</dt>
                        <dd>{row().projects}</dd>
                        <dt>May</dt>
                        <dd>{row().verbs}</dd>
                        <Show when={row().permit}>
                          <dt>Permissions</dt>
                          <dd class="mono">{row().permit}</dd>
                        </Show>
                        <Show when={row().never}>
                          <dt>Never</dt>
                          <dd class="mono">{row().never}</dd>
                        </Show>
                        <dt>Limits</dt>
                        <dd>{row().limits}</dd>
                      </dl>
                      <div class="small muted" data-expiry>
                        {row().expiry}
                      </div>
                    </div>
                    <Show when={row().editable}>
                      <button type="button" class="btn small" aria-label={`Edit grant of ${g.holder}`} onClick={() => setEditing(g)}>
                        Edit
                      </button>
                      <button type="button" class="btn small danger" aria-label={`Revoke grant of ${g.holder}`} onClick={() => void revoke(g)}>
                        Revoke
                      </button>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

function GrantDialog(props: { grant?: GrantView; onSaved: (g: GrantView) => void; onClose: () => void }) {
  const [draft, setDraft] = createSignal<GrantDraft>(draftOf(props.grant))
  const [errors, setErrors] = createSignal<Partial<Record<GrantField, string>>>({})
  const [problem, setProblem] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const set = <K extends keyof GrantDraft>(key: K, value: GrantDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    if (errors()[key]) setErrors((e) => ({ ...e, [key]: undefined }))
  }
  const submit = async (event: Event) => {
    event.preventDefault()
    setProblem("")
    const result = grantBody(draft())
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    setBusy(true)
    try {
      const path = props.grant ? `${GRANTS}/${enc(props.grant.id)}` : GRANTS
      const res = await (await api(path, { method: props.grant ? "PUT" : "POST", json: result.body })).json()
      const g = parseGrant(res?.grant)
      toast(props.grant ? "Grant updated" : "Grant created")
      if (g) props.onSaved(g)
      else props.onClose()
    } catch (e) {
      // The hub's validation (400 invalid; an unknown holder 404): next to its field, else above the buttons.
      const message = errorText(e)
      const field = e instanceof HttpError && (e.status === 400 || e.status === 404) ? hubErrorField(message) : undefined
      if (field) setErrors({ [field]: message })
      else setProblem(e instanceof HttpError && e.hint ? `${message} (${e.hint})` : message)
    } finally {
      setBusy(false)
    }
  }
  const FieldError = (p: { field: GrantField }) => (
    <Show when={errors()[p.field]}>
      <p class="field-error small" role="alert" data-error={p.field}>
        {errors()[p.field]}
      </p>
    </Show>
  )
  const Text = (p: { field: "holder" | "expires" | "maxActionsPerHour"; label: string; hint?: string; disabled?: boolean; placeholder?: string }): JSX.Element => (
    <label class="text-field grow">
      <span class="field-title">{p.label}</span>
      <Show when={p.hint}>
        <span class="field-desc muted small">{p.hint}</span>
      </Show>
      <input type="text" aria-label={p.label} placeholder={p.placeholder ?? ""} disabled={p.disabled} value={draft()[p.field]} onInput={(e) => set(p.field, e.currentTarget.value)} />
      <FieldError field={p.field} />
    </label>
  )
  const Lines = (p: { field: "projects" | "permit" | "never"; label: string; hint: string; placeholder?: string }): JSX.Element => (
    <label class="text-field">
      <span class="field-title">{p.label}</span>
      <span class="field-desc muted small">{p.hint}</span>
      <textarea rows={2} aria-label={p.label} placeholder={p.placeholder ?? ""} value={draft()[p.field]} onInput={(e) => set(p.field, e.currentTarget.value)} />
      <FieldError field={p.field} />
    </label>
  )
  return (
    <Dialog open title={props.grant ? `Edit grant of ${props.grant.holder}` : "New grant"} onClose={props.onClose} wide class="grant-dialog">
      <form class="grant-form" onSubmit={(e) => void submit(e)} novalidate>
        <Text
          field="holder"
          label="Holder"
          hint={props.grant ? "A grant's holder cannot change: revoke it and create another." : "@@orchestrator (a reserved role), @name or ses_… (pinned to that session), or app:<token id>"}
          placeholder="@@orchestrator"
          disabled={!!props.grant}
        />
        <Lines field="projects" label="Projects" hint="Absolute project directories, one per line (subdirectories and worktrees included)." placeholder="/home/you/projects/api" />
        <fieldset class="grant-verbs" aria-label="Actions">
          <span class="field-title">May</span>
          <For each={GRANT_VERBS}>
            {(verb) => (
              <label class="check">
                <input
                  type="checkbox"
                  aria-label={verb}
                  checked={draft().allow.includes(verb)}
                  onChange={(e) => set("allow", e.currentTarget.checked ? [...draft().allow, verb] : draft().allow.filter((v) => v !== verb))}
                />
                <span>{verb}</span>
              </label>
            )}
          </For>
        </fieldset>
        <FieldError field="allow" />
        <Lines field="permit" label="Permissions it may approve" hint="Patterns action[:glob], one per line (e.g. shell:bun test *)." />
        <Lines field="never" label="Never" hint="Patterns it may never approve, one per line; never wins." placeholder="shell:rm *" />
        <div class="row">
          <Text field="expires" label="Expires after" hint={props.grant ? "From now: saving restarts the countdown." : "30m, 8h, 2d (at most 30 days)"} />
          <Text field="maxActionsPerHour" label="Actions per hour" hint="1–1000" />
        </div>
        <label class="check">
          <input type="checkbox" aria-label="May allow always" checked={draft().allowAlways} onChange={(e) => set("allowAlways", e.currentTarget.checked)} />
          <span>May answer “Always allow” (still only for patterns it may approve)</span>
        </label>
        <FieldError field="allowAlways" />
        <Show when={problem()}>
          <p class="error" role="alert" data-error="form">
            {problem()}
          </p>
        </Show>
        <div class="row">
          <button type="submit" class="btn small primary" disabled={busy()}>
            {props.grant ? "Save" : "Create grant"}
          </button>
          <button type="button" class="btn small" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- activity (the agent audit) ----------

function Activity() {
  const [entries, setEntries] = createSignal<AuditEntryView[]>([])
  const [next, setNext] = createSignal<number | undefined>()
  const [state, setState] = createSignal<"loading" | "ready" | "failed">("loading")
  const [problem, setProblem] = createSignal("")
  const load = async (before?: number) => {
    setState("loading")
    try {
      const page = parseAuditPage(await getJSON(`/api/agent/audit?limit=${AUDIT_PAGE}${before !== undefined ? `&before=${before}` : ""}`))
      setEntries((list) => {
        if (before === undefined) return page.entries
        const seen = new Set(list.map((e) => e.seq))
        return [...list, ...page.entries.filter((e) => !seen.has(e.seq))]
      })
      setNext(page.next)
      setState("ready")
    } catch (e) {
      setProblem(errorText(e))
      setState("failed")
    }
  }
  void load()
  // Entries recorded while this list is open come first (SSE 'agent').
  const shown = () => {
    const newest = entries()[0]?.seq ?? 0
    return [...agentEntries().filter((e) => e.seq > newest), ...entries()]
  }
  return (
    <div class="stack">
      <Show when={state() !== "failed"} fallback={<p class="small err">Could not load: {problem()}</p>}>
        <Show when={shown().length || state() !== "ready"} fallback={<p class="small muted">No agent actions yet.</p>}>
          <ol class="list audit agent-audit">
            <For each={shown()}>
              {(e) => {
                const line = auditLine(e)
                return (
                  <li class="audit-row" data-seq={e.seq}>
                    <div class="grow">
                      <div class="name">
                        {line.who} <span class="muted">{line.what}</span>
                      </div>
                      <div class="small muted">
                        <span class={`audit-result ${line.tone}`}>{line.result}</span>
                        {line.grant ? ` · ${line.grant}` : ""}
                        {line.reason ? ` · ${line.reason}` : ""}
                      </div>
                    </div>
                    <time class="small muted" datetime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                      {ago(e.at, now())}
                    </time>
                  </li>
                )
              }}
            </For>
          </ol>
        </Show>
        <Show when={state() === "loading"}>
          <p class="small muted">Loading…</p>
        </Show>
        <Show when={state() === "ready" && next() !== undefined}>
          <button type="button" class="btn small" onClick={() => void load(next())}>
            Load older
          </button>
        </Show>
      </Show>
    </div>
  )
}
