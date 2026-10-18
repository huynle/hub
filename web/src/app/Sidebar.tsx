// Left sidebar: brand, search, New session, Needs you / Running / Pinned / open-session groups / Recents, and the
// account footer. Collapsible on desktop (⌘B); a drawer on phones.
import { For, Show, createMemo, createSignal } from "solid-js"
import { account } from "../core/account-core"
import { sidebarSections, voiceLive, type GroupBy, type SessionRow, type SidebarSort } from "../lib/sessions"
import { isRenaming, sessionMenu } from "./actions"
import { RenameTitle } from "./Rename"
import { enrollments, me, rows } from "./hub"
import { HubMark } from "./HubMark"
import { route, sessionHref } from "./router"
import { Icon, IconButton, Menu, StatusIcon, VoiceDot } from "./ui"
import { voiceState } from "./voice"

const GROUP_KEY = "hub.sidebar.groupBy"
const SORT_KEY = "hub.sidebar.sort"

export function Sidebar(props: { onClose: () => void; onCollapse: () => void; phone: boolean }) {
  const [query, setQuery] = createSignal("")
  const [groupBy, setGroupBy] = createSignal<GroupBy>(localStorage.getItem(GROUP_KEY) === "machine" ? "machine" : "project")
  const [sortBy, setSortBy] = createSignal<SidebarSort>(localStorage.getItem(SORT_KEY) === "title" ? "title" : "recent")
  const sections = createMemo(() => sidebarSections(rows(), { query: query(), groupBy: groupBy(), sortBy: sortBy() }))
  const current = () => {
    const r = route()
    return r.name === "session" ? r.id : undefined
  }
  const acc = () => account(me())
  const choose = (g: GroupBy | undefined, s: SidebarSort | undefined) => {
    if (g) {
      setGroupBy(g)
      localStorage.setItem(GROUP_KEY, g)
    }
    if (s) {
      setSortBy(s)
      localStorage.setItem(SORT_KEY, s)
    }
  }
  return (
    <nav class="sidebar" aria-label="Sessions">
      <div class="side-top">
        <a class="brand" href="/" onClick={() => props.phone && props.onClose()}>
          <HubMark class="brand-mark" />
          <span class="brand-name">Hub</span>
        </a>
        <Show when={props.phone} fallback={<IconButton icon="sidebar" label="Collapse sidebar (⌘B)" onClick={props.onCollapse} />}>
          <IconButton icon="close" label="Close sidebar" onClick={props.onClose} />
        </Show>
      </div>
      <div class="side-search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
      </div>
      <a class="side-new" href="/new" onClick={() => props.phone && props.onClose()}>
        <Icon name="plus" /> New session
      </a>
      <a class={`side-link${route().name === "home" ? " active" : ""}`} href="/" onClick={() => props.phone && props.onClose()}>
        <Icon name="home" /> All sessions
      </a>
      <div class="side-head">
        <span>Sessions</span>
        <Menu
          label="Group and sort"
          items={() => [
            { section: "Group by" },
            { label: "Project", checked: groupBy() === "project", run: () => choose("project", undefined) },
            { label: "Server", checked: groupBy() === "machine", run: () => choose("machine", undefined) },
            { section: "Sort by" },
            { label: "Recent activity", checked: sortBy() === "recent", run: () => choose(undefined, "recent") },
            { label: "Title", checked: sortBy() === "title", run: () => choose(undefined, "title") },
          ]}
        />
      </div>
      <div class="side-scroll">
        <Show when={sections().length} fallback={<p class="side-empty">{query() ? "No sessions match." : "No sessions yet."}</p>}>
          <For each={sections()}>
            {(section) => (
              <section class={`side-section ${section.kind}`} aria-label={section.title}>
                <div class="side-section-head">
                  <span class="side-section-title">{section.title}</span>
                  <Show when={section.kind === "group" && section.machineID}>
                    <a
                      class="icon-btn small"
                      aria-label={`New session in ${section.title}`}
                      title={`New session in ${section.title}`}
                      href={`/new?machine=${encodeURIComponent(section.machineID!)}${section.directory ? `&dir=${encodeURIComponent(section.directory)}` : ""}${section.key ? `&key=${encodeURIComponent(section.key)}` : ""}`}
                    >
                      <Icon name="plus" />
                    </a>
                  </Show>
                </div>
                <ul class="side-list">
                  <For each={section.rows}>{(r) => <SideRow row={r} active={current() === r.id} onPick={() => props.phone && props.onClose()} />}</For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </div>
      <div class="side-foot">
        <a class="account" href="/settings" onClick={() => props.phone && props.onClose()} aria-label={`Settings (${acc().title})`}>
          <span class={`avatar${acc().badge ? " admin" : ""}`} aria-hidden="true">
            {acc().initial}
          </span>
          <span class="account-name">{acc().title}</span>
          <Show when={enrollments().length}>
            <span class="badge" title="Machines waiting for approval">
              {enrollments().length}
            </span>
          </Show>
          <Icon name="settings" />
        </a>
      </div>
    </nav>
  )
}

function SideRow(props: { row: SessionRow; active: boolean; onPick: () => void }) {
  const r = () => props.row
  const voiceHere = () => voiceState().phase !== "off" && voiceState().sessionID === r().id
  return (
    <li class={`side-row${props.active ? " active" : ""}${r().unread ? " unread" : ""}${voiceHere() ? " voice-here" : ""}`}>
      <Show
        when={!isRenaming(r().id, "sidebar")}
        fallback={
          <span class="side-row-link">
            <StatusIcon state={r().state} />
            <RenameTitle id={r().id} title={r().title} place="sidebar" class="side-title">
              {null}
            </RenameTitle>
          </span>
        }
      >
      <a href={sessionHref(r().id)} class="side-row-link" aria-current={props.active ? "page" : undefined} onClick={props.onPick} title={`${r().title} · ${r().where} · ${r().machineName}`}>
        <StatusIcon state={r().state} />
        <Show when={voiceLive(r(), voiceState())}>
          <VoiceDot />
        </Show>
        <span class="side-title">{r().title}</span>
        <Show when={r().unread}>
          <span class="unread-dot" role="img" aria-label="Unread" />
        </Show>
      </a>
      </Show>
      <Menu label={`More actions for ${r().title}`} class="icon-btn small row-more" items={() => sessionMenu(r(), { open: false, place: "sidebar" })} />
    </li>
  )
}
