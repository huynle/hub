// Home: All sessions across connected servers. Desktop: a sortable, filterable table; phone: a compact list.
// Filters and sort are kept in localStorage; the search box is not.
import { For, Show, createMemo, createSignal } from "solid-js"
import { DEFAULT_TABLE, inactiveRows, parseTable, serializeTable, tableRows, voiceLive, type SessionRow, type SortKey, type TableFilters, type TableState } from "../lib/sessions"
import { archiveSessions, isRenaming, sessionMenu } from "./actions"
import { enrollments, hub, live, liveTick, rows, speechReady, me } from "./hub"
import { isPhone } from "./layout"
import { Naming, RenameTitle } from "./Rename"
import { navigate, sessionHref } from "./router"
import { speechSetup } from "../core/feedback-core"
import { jobsBadge } from "../core/jobs-core"
import { Dialog, Icon, Menu, SOURCE_LABEL, STATE_LABEL, StatusIcon, VoiceDot, ago, now } from "./ui"
import { voiceState } from "./voice"

const TABLE_KEY = "hub.table"

/** What a session is doing now: live activity first, then a pending request, else the catalog's `now`. */
export function currentActivity(r: SessionRow): string {
  liveTick()
  const blocker = r.blockers[0]
  if (r.state === "blocked" && blocker) return `${blocker.kind === "permission" ? "Permission" : "Question"}: ${blocker.summary}`
  if (r.state !== "working") return ""
  if (r.retry) return r.retry
  const feed = live.has(r.id) ? live.feed(r.id) : undefined
  const pulse = feed?.pulse()
  const jobs = r.jobs ? ` · ${jobsBadge(r.jobs)}` : ""
  if (pulse?.busy && pulse.label !== "Working") return pulse.label + jobs
  const doing = feed?.now() ?? r.nowText
  if (doing) return doing + jobs
  return r.jobs ? `Background: ${jobsBadge(r.jobs)}` : "Working"
}

const COLUMNS: Array<[SortKey, string]> = [
  ["status", "Status"],
  ["title", "Title"],
  ["project", "Project"],
  ["server", "Server"],
  ["source", "Open in"],
  ["activity", "Last activity"],
]

const CHIPS: Array<[string, string, Partial<TableFilters>]> = [
  ["needs", "Needs you", { status: "needs" }],
  ["running", "Running", { status: "running" }],
  ["idle", "Idle", { status: "idle" }],
  ["open", "Open in terminal", { source: "open" }],
  ["background", "Background", { source: "background" }],
  ["archived", "Archived", { archived: true }],
]

export function Home() {
  const [table, setTableRaw] = createSignal<TableState>(parseTable(localStorage.getItem(TABLE_KEY)))
  const [query, setQuery] = createSignal("")
  const setTable = (next: TableState) => {
    setTableRaw(next)
    localStorage.setItem(TABLE_KEY, serializeTable(next))
  }
  const shown = createMemo(() => tableRows(rows(), { ...table(), query: query() }))
  // Rows picked with the checkboxes; only the ones still shown count.
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set())
  const selected = createMemo(() => shown().filter((r) => picked().has(r.id)))
  const pick = (id: string, on: boolean) => {
    const next = new Set(picked())
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  const pickAll = (on: boolean) => setPicked(on ? new Set(shown().map((r) => r.id)) : new Set<string>())
  const archiveSelected = () => {
    archiveSessions(selected(), !table().filters.archived)
    setPicked(new Set<string>())
  }
  const [inactiveOpen, setInactiveOpen] = createSignal(false)
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
        <button type="button" class="btn small" onClick={() => setInactiveOpen(true)}>
          Archive inactive…
        </button>
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
      <Show when={selected().length}>
        <div class="bulk-bar" role="region" aria-label="Selected sessions">
          <span>{selected().length} selected</span>
          <button type="button" class="btn small" onClick={archiveSelected}>
            {table().filters.archived ? "Unarchive" : "Archive"}
          </button>
          <button type="button" class="btn small" onClick={() => pickAll(false)}>
            Clear selection
          </button>
        </div>
      </Show>
      <p class="count muted" role="status">
        {hub.machines === undefined ? "Loading…" : `${shown().length} of ${rows().filter((r) => !r.hidden).length} sessions`}
      </p>
      <Show when={hub.machines && hub.machines.length === 0}>
        <div class="empty">
          <p class="display">No machines yet</p>
          <p class="muted">In OpenCode run /voice → Connect this machine, then approve it here.</p>
        </div>
      </Show>
      <Show when={isPhone()} fallback={<SessionTable rows={shown()} table={table()} sortBy={sortBy} picked={picked()} pick={pick} pickAll={pickAll} />}>
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
      <ArchiveInactive open={inactiveOpen()} rows={rows()} onClose={() => setInactiveOpen(false)} />
    </div>
  )
}

const INACTIVE_DAYS = 30

/** "Archive inactive…": sessions without activity for more than N days, archived after a confirmation with the count. */
function ArchiveInactive(props: { open: boolean; rows: SessionRow[]; onClose: () => void }) {
  const [days, setDays] = createSignal(String(INACTIVE_DAYS))
  const matches = createMemo(() => (props.open ? inactiveRows(props.rows, Number(days()), now()) : []))
  const n = () => matches().length
  const confirm = () => {
    archiveSessions(matches(), true)
    props.onClose()
  }
  return (
    <Dialog open={props.open} title="Archive inactive sessions" onClose={props.onClose}>
      <form
        class="archive-inactive"
        onSubmit={(e) => {
          e.preventDefault()
          if (n()) confirm()
        }}
      >
        <label class="field">
          <span>Inactive for more than (days)</span>
          <input type="number" min="1" step="1" inputMode="numeric" value={days()} onInput={(e) => setDays(e.currentTarget.value)} />
        </label>
        <p class="muted small">
          {n() === 1 ? "1 session" : `${n()} sessions`} without activity for more than {Number(days()) === 1 ? "1 day" : `${days() || "?"} days`} (not running, pinned or open in a
          terminal). Archived sessions leave your lists on every device; nothing is deleted and you can unarchive them under Archived.
        </p>
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={!n()}>
            {n() === 1 ? "Archive 1 session" : `Archive ${n()} sessions`}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function SessionTable(props: {
  rows: SessionRow[]
  table: TableState
  sortBy: (key: SortKey) => void
  picked: ReadonlySet<string>
  pick: (id: string, on: boolean) => void
  pickAll: (on: boolean) => void
}) {
  const allPicked = () => props.rows.length > 0 && props.rows.every((r) => props.picked.has(r.id))
  const sortState = (key: SortKey) => (props.table.sort.key === key ? (props.table.sort.dir === "asc" ? "ascending" : "descending") : "none")
  return (
    <table class="sessions-table">
      <thead>
        <tr>
          <th class="col-pick">
            <input type="checkbox" aria-label="Select all shown sessions" checked={allPicked()} onChange={(e) => props.pickAll(e.currentTarget.checked)} />
          </th>
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
            <tr class={`${r.unread ? "unread" : ""}`} onClick={(e) => !(e.target as Element).closest("button,a,select,input") && navigate(sessionHref(r.id))}>
              <td class="col-pick">
                <input type="checkbox" aria-label={`Select ${r.title}`} checked={props.picked.has(r.id)} onChange={(e) => props.pick(r.id, e.currentTarget.checked)} />
              </td>
              <td class="col-status">
                <StatusIcon state={r.state} />
                <span class="sr-only">{STATE_LABEL[r.state]}</span>
                <Show when={r.jobs}>
                  <span class="jobs-badge" title={jobsBadge(r.jobs)} aria-label={jobsBadge(r.jobs)}>
                    {r.jobs}
                  </span>
                </Show>
              </td>
              <td class="col-title">
                <Show when={voiceLive(r, voiceState())}>
                  <VoiceDot />
                </Show>
                <RenameTitle id={r.id} title={r.title} place="table">
                  <a href={sessionHref(r.id)}>{r.title}</a>
                </RenameTitle>
                <Naming id={r.id} />
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
              <td class="col-activity">{ago(r.updated, now())}</td>
              <td class="col-now muted">{currentActivity(r)}</td>
              <td class="col-actions">
                <Menu label={`More actions for ${r.title}`} class="icon-btn small" items={() => sessionMenu(r, { place: "table" })} />
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
      <Show
        when={!isRenaming(r().id, "phone")}
        fallback={
          <span class="home-item-link">
            <StatusIcon state={r().state} />
            <RenameTitle id={r().id} title={r().title} place="phone">
              {null}
            </RenameTitle>
          </span>
        }
      >
      <a href={sessionHref(r().id)} class="home-item-link">
        <StatusIcon state={r().state} />
        <span class="home-item-text">
          <span class="home-item-title">
            <Show when={voiceLive(r(), voiceState())}>
              <VoiceDot />
            </Show>
            {r().title}
            <Naming id={r().id} />
            <Show when={r().unread}>
              <span class="unread-dot" role="img" aria-label="Unread" />
            </Show>
          </span>
          <span class="home-item-meta muted">{currentActivity(r()) || `${r().where} · ${r().machineName} · ${ago(r().updated, now())}`}</span>
        </span>
      </a>
      </Show>
      <Menu label={`More actions for ${r().title}`} class="icon-btn small" items={() => sessionMenu(r(), { place: "phone" })} />
    </li>
  )
}
