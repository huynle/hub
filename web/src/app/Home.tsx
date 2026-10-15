// Home: All sessions across connected servers. Desktop: a sortable, filterable table; phone: a compact list.
// Filters and sort are kept in localStorage; the search box is not.
import { For, Show, createMemo, createSignal } from "solid-js"
import { DEFAULT_TABLE, parseTable, serializeTable, tableRows, type SessionRow, type SortKey, type TableFilters, type TableState } from "../lib/sessions"
import { sessionMenu } from "./actions"
import { enrollments, hub, live, liveTick, rows, speechReady, me } from "./hub"
import { isPhone } from "./layout"
import { navigate, sessionHref } from "./router"
import { speechSetup } from "../core/feedback-core"
import { Icon, Menu, SOURCE_LABEL, STATE_LABEL, StatusIcon, ago, now } from "./ui"

const TABLE_KEY = "hub.table"

/** What a session is doing now: live activity first, then a pending request, else the catalog's `now`. */
export function currentActivity(r: SessionRow): string {
  liveTick()
  const blocker = r.blockers[0]
  if (r.state === "blocked" && blocker) return `${blocker.kind === "permission" ? "Permission" : "Question"}: ${blocker.summary}`
  if (r.state !== "working") return ""
  const feed = live.has(r.id) ? live.feed(r.id) : undefined
  const pulse = feed?.pulse()
  if (pulse?.busy && pulse.label !== "Working") return pulse.label
  return feed?.now() ?? r.nowText ?? "Working"
}

const COLUMNS: Array<[SortKey, string]> = [
  ["status", "Status"],
  ["title", "Title"],
  ["project", "Project"],
  ["server", "Server"],
  ["source", "Open in"],
  ["voice", "Voice"],
  ["activity", "Last activity"],
]

const CHIPS: Array<[string, string, Partial<TableFilters>]> = [
  ["needs", "Needs you", { status: "needs" }],
  ["running", "Running", { status: "running" }],
  ["idle", "Idle", { status: "idle" }],
  ["open", "Open in terminal", { source: "open" }],
  ["background", "Background", { source: "background" }],
  ["voice-on", "Voice on", { voice: "on" }],
  ["voice-off", "Voice off", { voice: "off" }],
  ["hidden", "Hidden", { hidden: true }],
]

export function Home() {
  const [table, setTableRaw] = createSignal<TableState>(parseTable(localStorage.getItem(TABLE_KEY)))
  const [query, setQuery] = createSignal("")
  const setTable = (next: TableState) => {
    setTableRaw(next)
    localStorage.setItem(TABLE_KEY, serializeTable(next))
  }
  const shown = createMemo(() => tableRows(rows(), { ...table(), query: query() }))
  const machines = () => hub.machines ?? []
  const chipOn = (patch: Partial<TableFilters>) => (Object.keys(patch) as Array<keyof TableFilters>).every((k) => table().filters[k] === patch[k])
  const toggleChip = (patch: Partial<TableFilters>) => {
    const f = table().filters
    const reset = Object.fromEntries((Object.keys(patch) as Array<keyof TableFilters>).map((k) => [k, DEFAULT_TABLE.filters[k]]))
    setTable({ ...table(), filters: chipOn(patch) ? { ...f, ...reset } : { ...f, ...patch } })
  }
  const sortBy = (key: SortKey) => {
    const s = table().sort
    setTable({ ...table(), sort: { key, dir: s.key === key ? (s.dir === "asc" ? "desc" : "asc") : key === "activity" ? "desc" : "asc" } })
  }
  const setup = () => speechSetup(speechReady() ?? undefined, me()?.publicURL)
  return (
    <div class="home">
      <header class="home-head">
        <h1 class="display">All sessions</h1>
        <a class="btn primary" href="/new">
          <Icon name="plus" /> New session
        </a>
      </header>
      <Show when={enrollments().length}>
        <div class="banner">
          <span>
            {enrollments().length === 1 ? `${enrollments()[0]!.machineName} wants to connect.` : `${enrollments().length} machines want to connect.`}
          </span>
          <a class="btn small" href="/settings#machines">
            Review
          </a>
        </div>
      </Show>
      <Show when={setup()}>
        <div class="banner">
          <span>
            <strong>Set up speech</strong> · {setup()!.reason}
          </span>
          <a class="btn small" href="/settings#speech">
            Set up
          </a>
        </div>
      </Show>
      <div class="home-tools">
        <label class="search">
          <Icon name="search" />
          <input type="search" placeholder="Search title, project, folder or server" aria-label="Search sessions" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <Show when={machines().length > 1}>
          <select aria-label="Server" value={table().filters.machine} onChange={(e) => setTable({ ...table(), filters: { ...table().filters, machine: e.currentTarget.value } })}>
            <option value="">All servers</option>
            <For each={machines()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
          </select>
        </Show>
      </div>
      <div class="chips" role="group" aria-label="Filters">
        <For each={CHIPS}>
          {([id, label, patch]) => (
            <button type="button" class="chip" data-chip={id} aria-pressed={chipOn(patch)} onClick={() => toggleChip(patch)}>
              {label}
            </button>
          )}
        </For>
      </div>
      <p class="count muted" role="status">
        {hub.machines === undefined ? "Loading…" : `${shown().length} of ${rows().filter((r) => !r.hidden).length} sessions`}
      </p>
      <Show when={hub.machines && hub.machines.length === 0}>
        <div class="empty">
          <p class="display">No machines yet</p>
          <p class="muted">In OpenCode run /voice → Connect this machine, then approve it here.</p>
        </div>
      </Show>
      <Show when={isPhone()} fallback={<SessionTable rows={shown()} table={table()} sortBy={sortBy} />}>
        <ul class="home-list">
          <For each={shown()}>{(r) => <PhoneRow row={r} />}</For>
        </ul>
      </Show>
      <For each={machines().filter((m) => !m.online)}>
        {(m) => (
          <p class="muted small offline-line">
            <strong>{m.name}</strong> · offline · seen {ago(m.lastSeen, now())}
          </p>
        )}
      </For>
    </div>
  )
}

function SessionTable(props: { rows: SessionRow[]; table: TableState; sortBy: (key: SortKey) => void }) {
  const sortState = (key: SortKey) => (props.table.sort.key === key ? (props.table.sort.dir === "asc" ? "ascending" : "descending") : "none")
  return (
    <table class="sessions-table">
      <thead>
        <tr>
          <For each={COLUMNS}>
            {([key, label]) => (
              <th aria-sort={sortState(key)} class={`col-${key}`}>
                <button type="button" class="th-btn" onClick={() => props.sortBy(key)}>
                  {label}
                  <span class="sort-mark" aria-hidden="true">
                    {props.table.sort.key === key ? (props.table.sort.dir === "asc" ? "↑" : "↓") : ""}
                  </span>
                </button>
              </th>
            )}
          </For>
          <th class="col-now">Now</th>
          <th class="col-actions">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows} fallback={<tr><td colSpan={9} class="muted empty-cell">No sessions match.</td></tr>}>
          {(r) => (
            <tr class={`${r.unread ? "unread" : ""}`} onClick={(e) => !(e.target as Element).closest("button,a,select") && navigate(sessionHref(r.id))}>
              <td class="col-status">
                <StatusIcon state={r.state} />
                <span class="sr-only">{STATE_LABEL[r.state]}</span>
              </td>
              <td class="col-title">
                <a href={sessionHref(r.id)}>{r.title}</a>
                <Show when={r.unread}>
                  <span class="unread-dot" role="img" aria-label="Unread" />
                </Show>
              </td>
              <td class="col-project" title={r.directory}>
                {r.where}
              </td>
              <td class="col-server">
                <span class={r.machineOnline ? "" : "muted"}>{r.machineName}</span>
              </td>
              <td class="col-source">{SOURCE_LABEL[r.source]}</td>
              <td class="col-voice">
                <span class={`voice-pill${r.conversation ? " live" : r.exposed ? " on" : ""}`}>{r.conversation ? "Talking" : r.exposed ? "On" : "Off"}</span>
              </td>
              <td class="col-activity">{ago(r.updated, now())}</td>
              <td class="col-now muted">{currentActivity(r)}</td>
              <td class="col-actions">
                <Menu label={`More actions for ${r.title}`} class="icon-btn small" items={() => sessionMenu(r)} />
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

function PhoneRow(props: { row: SessionRow }) {
  const r = () => props.row
  return (
    <li class={`home-item${r().unread ? " unread" : ""}`}>
      <a href={sessionHref(r().id)} class="home-item-link">
        <StatusIcon state={r().state} />
        <span class="home-item-text">
          <span class="home-item-title">
            {r().title}
            <Show when={r().unread}>
              <span class="unread-dot" role="img" aria-label="Unread" />
            </Show>
          </span>
          <span class="home-item-meta muted">{currentActivity(r()) || `${r().where} · ${r().machineName} · ${ago(r().updated, now())}`}</span>
        </span>
        <Show when={r().conversation || r().exposed}>
          <span class={`voice-badge${r().conversation ? " live" : ""}`} title="Voice on">
            <Icon name={r().conversation ? "wave" : "mic"} />
          </span>
        </Show>
      </a>
      <Menu label={`More actions for ${r().title}`} class="icon-btn small" items={() => sessionMenu(r())} />
    </li>
  )
}
