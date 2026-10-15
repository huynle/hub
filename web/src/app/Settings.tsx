// /settings: account, notifications, voice, speech, machines (with approvals), devices and admin screens.
import { For, Show, createResource, createSignal, onMount, type JSX } from "solid-js"
import {
  USER_FILTERS,
  USER_SORTS,
  account,
  adminError,
  adminTabs,
  auditRows,
  isAdmin,
  userActions,
  usersView,
  type AdminTab,
  type AdminUser,
  type UserFilter,
  type UserSort,
} from "../core/account-core"
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatSpeed } from "../core/feedback-core"
import { api, enc, errorText, getJSON } from "./api"
import { enrollments, ensureMe, hub, loadEnrollments, me, setMe, stopEvents } from "./hub"
import { isPhone, toggleSidebar } from "./layout"
import { currentSubscription, disableNotifications, enableNotifications, pushSupported } from "./push"
import { location$, navigate } from "./router"
import { SpeechSettingsPanel } from "./SpeechSettings"
import { toast } from "./toast"
import { IconButton, ago, now, plural } from "./ui"
import { voicePrefs } from "../voice/audio"

const SECTIONS: Array<[string, string]> = [
  ["account", "Account"],
  ["notifications", "Notifications"],
  ["voice", "Voice"],
  ["speech", "Speech"],
  ["machines", "Machines"],
  ["devices", "Devices"],
  ["admin", "Admin"],
]

function Section(props: { id: string; title: string; children: JSX.Element }) {
  return (
    <section class="settings-section" id={props.id} aria-labelledby={`h-${props.id}`}>
      <h2 id={`h-${props.id}`}>{props.title}</h2>
      {props.children}
    </section>
  )
}

export function Settings() {
  onMount(() => {
    const id = location$().hash.slice(1)
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }))
  })
  const sections = () => SECTIONS.filter(([id]) => id !== "admin" || isAdmin(me()))
  return (
    <div class="settings">
      <header class="topbar">
        <Show when={isPhone()}>
          <IconButton icon="menu" label="Open sidebar" onClick={toggleSidebar} />
        </Show>
        <h1 class="title">Settings</h1>
      </header>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <For each={sections()}>
            {([id, label]) => (
              <a href={`#${id}`} onClick={(e) => (e.preventDefault(), document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), history.replaceState(null, "", `#${id}`))}>
                {label}
              </a>
            )}
          </For>
        </nav>
        <div class="settings-content">
          <AccountSection />
          <NotificationsSection />
          <VoiceSection />
          <Section id="speech" title="Speech">
            <SpeechSettingsPanel />
          </Section>
          <MachinesSection />
          <DevicesSection />
          <Show when={isAdmin(me())}>
            <AdminSection />
          </Show>
          <p class="small muted">
            Server {me()?.publicURL ?? location.origin} · v{me()?.version ?? "?"}
          </p>
        </div>
      </div>
    </div>
  )
}

async function signOut(): Promise<void> {
  if (account(me()).mode === "pairing" && !confirm("Sign out this device? You will need a new pairing code.")) return
  const sub = await currentSubscription().catch(() => undefined)
  await sub?.unsubscribe().catch(() => {})
  await api("/api/logout", { method: "POST", json: {} }).catch(() => {})
  stopEvents()
  location.href = "/"
}

function AccountSection() {
  const acc = () => account(me())
  return (
    <Section id="account" title="Account">
      <div class="account-card">
        <span class={`avatar large${acc().badge ? " admin" : ""}`} aria-hidden="true">
          {acc().initial}
        </span>
        <div class="grow">
          <div>
            <strong>{acc().title}</strong>
            <Show when={acc().badge}>
              <span class="badge-pill">{acc().badge}</span>
            </Show>
          </div>
          <Show when={acc().subtitle}>
            <div class="small muted">{acc().subtitle}</div>
          </Show>
          <div class="small muted">This device: {me()?.device?.name ?? "paired"}</div>
        </div>
        <button type="button" class="btn danger" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </Section>
  )
}

function NotificationsSection() {
  const [sub, { refetch }] = createResource(() => currentSubscription().catch(() => undefined))
  const [prefs, setPrefs] = createSignal<Record<string, boolean> | undefined>()
  onMount(async () => setPrefs((await getJSON("/api/push/prefs").catch(() => undefined))?.prefs))
  const state = () =>
    !pushSupported() ? "Not supported in this browser. On iPhone, add the app to the Home Screen (iOS 16.4+)." : Notification.permission === "denied" ? "Blocked in the browser's site settings." : sub() ? "On for this device." : "Off for this device."
  const toggle = async (key: string, on: boolean) => {
    try {
      setPrefs((await (await api("/api/push/prefs", { method: "PUT", json: { [key]: on } })).json()).prefs)
    } catch (e) {
      toast(errorText(e), "err")
    }
  }
  return (
    <Section id="notifications" title="Notifications">
      <p class="small muted">{state()}</p>
      <Show when={pushSupported() && Notification.permission !== "denied"}>
        <Show
          when={sub()}
          fallback={
            <button type="button" class="btn small primary" onClick={() => enableNotifications().then(() => (toast("Notifications are on"), refetch()), (e) => toast(errorText(e), "err"))}>
              Enable notifications
            </button>
          }
        >
          <button type="button" class="btn small" onClick={() => disableNotifications().then(() => (toast("Notifications are off for this device"), refetch()))}>
            Turn off on this device
          </button>
        </Show>
      </Show>
      <Show when={prefs()}>
        <ul class="switches">
          <For
            each={[
              ["handoff", "Hand-offs from the terminal"],
              ["blocked", "Session needs permission or an answer"],
              ["finished", "Session finished (not voice turns)"],
              ["say", "Read agent replies as notifications when the phone is locked"],
            ]}
          >
            {([key, label]) => (
              <li>
                <label class="switch">
                  <span>{label}</span>
                  <input type="checkbox" checked={!!prefs()![key!]} onChange={(e) => void toggle(key!, e.currentTarget.checked)} />
                </label>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  )
}

function VoiceSection() {
  const [speed, setSpeed] = createSignal(voicePrefs.speed)
  return (
    <Section id="voice" title="Voice">
      <ul class="switches">
        <li class="speed">
          <label for="voice-speed">Voice speed</label>
          <input
            id="voice-speed"
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={speed()}
            aria-valuetext={formatSpeed(speed())}
            onInput={(e) => {
              voicePrefs.speed = Number(e.currentTarget.value)
              setSpeed(voicePrefs.speed)
            }}
          />
          <output for="voice-speed">{formatSpeed(speed())}</output>
        </li>
        <li>
          <label class="switch">
            <span>Progress cues</span>
            <input type="checkbox" checked={voicePrefs.cues} onChange={(e) => (voicePrefs.cues = e.currentTarget.checked)} />
          </label>
          <p class="small muted">In Voice mode: a soft tone when the agent hears you, “Working on it.”, “Started a subagent.” and “Still working.”</p>
        </li>
        <li>
          <label class="switch">
            <span>Keep listening when the screen is off</span>
            <input type="checkbox" checked={voicePrefs.background} onChange={(e) => (voicePrefs.background = e.currentTarget.checked)} />
          </label>
          <p class="small muted">Off: the screen stays on while listening. On: lock-screen controls and best-effort listening with the screen off (Android Chrome). Applies the next time Voice mode starts.</p>
        </li>
      </ul>
    </Section>
  )
}

async function decide(e: { userCode: string; machineName: string }, action: "approve" | "deny"): Promise<void> {
  try {
    await api(`/api/enrollments/${enc(e.userCode)}/${action}`, { method: "POST", json: {} })
    toast(action === "approve" ? `${e.machineName} approved; it belongs to you` : "Request denied")
  } catch (err) {
    toast(errorText(err), "err")
  }
  void loadEnrollments()
}

function Approvals() {
  return (
    <Show when={enrollments().length}>
      <h3>Waiting for approval</h3>
      <ul class="list">
        <For each={enrollments()}>
          {(e) => (
            <li>
              <div class="grow">
                <div class="name">{e.machineName}</div>
                <div class="small muted">
                  Code {e.userCode} · requested {ago(e.created, now())}
                </div>
              </div>
              <button type="button" class="btn small primary" onClick={() => void decide(e, "approve")}>
                Approve
              </button>
              <button type="button" class="btn small danger" onClick={() => void decide(e, "deny")}>
                Deny
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function MachinesSection() {
  const revoke = async (m: { id: string; name: string }) => {
    if (!confirm(`Revoke ${m.name}? Its OpenCode processes disconnect and it must be connected again.`)) return
    try {
      await api(`/api/machines/${enc(m.id)}`, { method: "DELETE" })
      toast(`${m.name} revoked`)
    } catch (e) {
      toast(errorText(e), "err")
    }
  }
  return (
    <Section id="machines" title="Machines">
      <Approvals />
      <Show when={(hub.machines ?? []).length} fallback={<p class="small muted">None. In OpenCode run /voice → Connect this machine.</p>}>
        <ul class="list">
          <For each={hub.machines}>
            {(m) => (
              <li>
                <div class="grow">
                  <div class="name">
                    <span class={`online-dot${m.online ? " on" : ""}`} aria-hidden="true" /> {m.name}
                  </div>
                  <div class="small muted">{m.online ? `online · ${plural(m.processes.length, "OpenCode process", )}` : `offline · seen ${ago(m.lastSeen, now())}`}</div>
                </div>
                <button type="button" class="btn small danger" aria-label={`Revoke machine ${m.name}`} onClick={() => void revoke(m)}>
                  Revoke
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  )
}

function DevicesSection() {
  const [devices, { refetch }] = createResource(() => getJSON("/api/devices").then((r) => r.devices as Array<{ id: string; name: string; lastSeen: number; current?: boolean }>))
  const revoke = async (d: { id: string; name: string; current?: boolean }) => {
    if (d.current) return void signOut()
    if (!confirm(`Revoke ${d.name}?`)) return
    try {
      await api(`/api/devices/${enc(d.id)}`, { method: "DELETE" })
      toast(`${d.name} revoked`)
    } catch (e) {
      toast(errorText(e), "err")
    }
    void refetch()
  }
  return (
    <Section id="devices" title="Devices">
      <Show when={devices()} fallback={<p class="small muted">{devices.error ? errorText(devices.error) : "Loading…"}</p>}>
        <ul class="list">
          <For each={devices()}>
            {(d) => (
              <li>
                <div class="grow">
                  <div class="name">
                    {d.name}
                    <Show when={d.current}>
                      <span class="muted"> · this device</span>
                    </Show>
                  </div>
                  <div class="small muted">last seen {ago(d.lastSeen, now())}</div>
                </div>
                <button type="button" class="btn small danger" onClick={() => void revoke(d)}>
                  {d.current ? "Sign out" : "Revoke"}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  )
}

const listOf = (res: unknown, key: string): any[] => (Array.isArray(res) ? res : Array.isArray((res as Record<string, unknown>)?.[key]) ? ((res as Record<string, unknown>)[key] as any[]) : [])
const userLabel = (u: AdminUser) => (u.id === "local" ? "Hub owner (pairing)" : u.name || u.email || u.id)

function AdminSection() {
  const tabs = () => adminTabs(me())
  const [tab, setTab] = createSignal<AdminTab>(tabs()[0]?.[0] ?? "machines")
  const [notice, setNotice] = createSignal("")
  const change = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run()
      setNotice("")
      toast(done)
      return true
    } catch (e) {
      setNotice(adminError(e as Error & { status?: number }))
      toast(notice(), "err")
      return false
    }
  }
  return (
    <Section id="admin" title="Admin">
      <div class="chips" role="group" aria-label="Admin sections">
        <For each={tabs()}>
          {([id, label]) => (
            <button type="button" class="chip" aria-pressed={tab() === id} onClick={() => (setTab(id), setNotice(""))}>
              {label}
              <Show when={id === "approvals" && enrollments().length}>
                <span class="count">{enrollments().length}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={notice()}>
        <p class="error" role="alert">
          {notice()}
        </p>
      </Show>
      <Show when={tab() === "users"}>
        <AdminUsers change={change} />
      </Show>
      <Show when={tab() === "machines"}>
        <AdminMachines change={change} />
      </Show>
      <Show when={tab() === "approvals"}>
        <p class="small muted">Approving a machine makes it yours. Someone else's machine: let them approve it from their phone with the code OpenCode shows (/approve?code=…).</p>
        <Show when={enrollments().length} fallback={<p class="muted">No machines are waiting for approval.</p>}>
          <Approvals />
        </Show>
      </Show>
      <Show when={tab() === "audit"}>
        <AdminAudit />
      </Show>
    </Section>
  )
}

function AdminUsers(props: { change: (run: () => Promise<unknown>, done: string) => Promise<boolean> }) {
  const [users, { refetch }] = createResource(() => getJSON("/api/admin/users").then((r) => listOf(r, "users") as AdminUser[]))
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<UserFilter>("all")
  const [sort, setSort] = createSignal<UserSort>("role")
  const act = async (u: AdminUser, a: ReturnType<typeof userActions>[number]) => {
    if (!confirm(a.confirm)) return
    const ok = await props.change(() => api(`/api/admin/users/${enc(u.id)}`, { method: "PUT", json: a.change }), `${userLabel(u)}: ${a.label.toLowerCase()} done`)
    if (ok && u.id === me()?.user?.id) {
      setMe(undefined)
      await ensureMe().catch(() => false)
    }
    void refetch()
  }
  return (
    <div class="stack">
      <div class="row">
        <input type="search" class="grow" placeholder="Search by email or name" aria-label="Search users" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <select aria-label="Show" value={filter()} onChange={(e) => setFilter(e.currentTarget.value as UserFilter)}>
          <For each={USER_FILTERS}>{([v, t]) => <option value={v}>{t}</option>}</For>
        </select>
        <select aria-label="Sort by" value={sort()} onChange={(e) => setSort(e.currentTarget.value as UserSort)}>
          <For each={USER_SORTS}>{([v, t]) => <option value={v}>{t}</option>}</For>
        </select>
      </div>
      <Show when={users()} fallback={<p class="muted">{users.error ? `Could not load: ${adminError(users.error)}` : "Loading…"}</p>}>
        <ul class="list">
          <For each={usersView(users()!, { query: query(), filter: filter(), sort: sort() })} fallback={<li class="muted">No users match.</li>}>
            {(u) => (
              <li class={u.disabled ? "disabled" : ""}>
                <div class="grow">
                  <div class="name">
                    {userLabel(u)}
                    <Show when={u.role === "admin"}>
                      <span class="badge-pill">Admin</span>
                    </Show>
                    <Show when={u.disabled}>
                      <span class="badge-pill off">Disabled</span>
                    </Show>
                    <Show when={u.id === me()?.user?.id}>
                      <span class="badge-pill">You</span>
                    </Show>
                  </div>
                  <Show when={u.name && u.email}>
                    <div class="small muted">{u.email}</div>
                  </Show>
                  <div class="small muted">
                    {plural(u.machines ?? 0, "machine")} · {plural(u.devices ?? 0, "device")} · seen {ago(u.lastSeen, now()) || "never"}
                  </div>
                </div>
                <For each={userActions(u, users()!, me()?.user?.id)}>
                  {(a) => (
                    <button type="button" class={`btn small${a.danger ? " danger" : ""}`} onClick={() => void act(u, a)}>
                      {a.label}
                    </button>
                  )}
                </For>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function AdminMachines(props: { change: (run: () => Promise<unknown>, done: string) => Promise<boolean> }) {
  const [machines, { refetch }] = createResource(() => getJSON("/api/admin/machines").then((r) => listOf(r, "machines")))
  return (
    <Show when={machines()} fallback={<p class="muted">{machines.error ? `Could not load: ${adminError(machines.error)}` : "Loading…"}</p>}>
      <Show when={machines()!.length} fallback={<p class="muted">No machines are connected to this hub yet.</p>}>
        <ul class="list">
          <For each={machines()}>
            {(m) => {
              const owner = m.ownerEmail ?? (m.ownerID === "local" ? "hub owner" : m.ownerID) ?? "unknown"
              return (
                <li>
                  <div class="grow">
                    <div class="name">
                      <span class={`online-dot${m.online ? " on" : ""}`} aria-hidden="true" /> {m.name}
                    </div>
                    <div class="small muted">
                      {owner}
                      {m.ownerID === me()?.user?.id ? " (you)" : ""} · {m.online ? "online" : `offline · seen ${ago(m.lastSeen, now())}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="btn small danger"
                    onClick={async () => {
                      if (!confirm(`Revoke ${m.name} (${owner})? Its OpenCode processes disconnect and it must be connected again.`)) return
                      await props.change(() => api(`/api/admin/machines/${enc(m.id)}`, { method: "DELETE" }), `${m.name} revoked`)
                      void refetch()
                    }}
                  >
                    Revoke
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </Show>
  )
}

function AdminAudit() {
  const [rows] = createResource(async () => {
    const [res, users, machines] = await Promise.all([
      getJSON("/api/admin/audit"),
      getJSON("/api/admin/users").then((r) => listOf(r, "users"), () => []),
      getJSON("/api/admin/machines").then((r) => listOf(r, "machines"), () => []),
    ])
    const names = [...users.map((u) => ({ id: u.id, email: u.id === "local" ? "hub owner" : u.email, name: u.name })), ...machines.map((m) => ({ id: m.id, name: m.name }))]
    return auditRows(listOf(res, "audit").length ? listOf(res, "audit") : listOf(res, "entries"), names)
  })
  return (
    <Show when={rows()} fallback={<p class="muted">{rows.error ? `Could not load: ${adminError(rows.error)}` : "Loading…"}</p>}>
      <Show when={rows()!.length} fallback={<p class="muted">Nothing recorded yet.</p>}>
        <ol class="list audit">
          <For each={rows()}>
            {(r) => (
              <li>
                <div class="grow">
                  <div class="name">{r.action}</div>
                  <div class="small muted">
                    {r.actor}
                    {r.target ? ` → ${r.target}` : ""}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </div>
                </div>
                <time class="small muted" datetime={new Date(r.at).toISOString()} title={new Date(r.at).toLocaleString()}>
                  {ago(r.at, now())}
                </time>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </Show>
  )
}

export { navigate }
