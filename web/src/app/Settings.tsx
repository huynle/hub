// /settings: account, notifications, voice, speech, machines (with approvals), devices, agents and admin screens.
import { For, Show, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js"
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
import { SENSITIVITIES, type Sensitivity } from "../core/speech-vad"
import { api, enc, errorText, getJSON } from "./api"
import { enrollments, ensureMe, hub, loadEnrollments, me, setMe, stopEvents } from "./hub"
import { isPhone, toggleSidebar } from "./layout"
import { ACTIVITY_MINUTES, describeTestResult, localTimeZone, NOTIFY_GROUPS, NOTIFY_KINDS, notifyStatus, notifySummary, type QuietHours } from "../core/notify-core"
import { currentSubscription, disableNotifications, enableNotifications, mutedSessions, notifyEnv, pushRevision, sendTestNotification, type PushPrefsView } from "./push"
import { location$, navigate } from "./router"
import { SpeechSettingsPanel } from "./SpeechSettings"
import { AgentsSection } from "./AgentsSettings"
import { toast } from "./toast"
import { Dialog, IconButton, ago, now, plural } from "./ui"
import { linkCountdown, linkDeadline, linkedDevice } from "../core/link-core"
import { qrCode, qrSvgPath } from "../lib/qr"
import { voicePrefs } from "../voice/audio"
import { FONT_SCALE_DEFAULT, FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP, formatScale } from "../core/font-scale"
import { setTextScale, textScale } from "./text-size"

const SECTIONS: Array<[string, string]> = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["notifications", "Notifications"],
  ["voice", "Voice"],
  ["speech", "Speech"],
  ["machines", "Machines"],
  ["devices", "Devices"],
  ["agents", "Agents"],
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
          <AppearanceSection />
          <NotificationsSection />
          <VoiceSection />
          <Section id="speech" title="Speech">
            <SpeechSettingsPanel />
          </Section>
          <MachinesSection />
          <DevicesSection />
          <AgentsSection />
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
  const [info, { refetch }] = createResource(pushRevision, () => notifyEnv())
  const [busy, setBusy] = createSignal(false)
  const [testResult, setTestResult] = createSignal<{ ok: boolean; text: string } | undefined>()
  const [testKind, setTestKind] = createSignal("")
  const [prefs, setPrefs] = createSignal<Record<string, boolean> | undefined>()
  const [quiet, setQuiet] = createSignal<QuietHours | null>(null)
  const [minutes, setMinutes] = createSignal<number | undefined>()
  const currentMinutes = () => minutes() ?? view()?.activityMinutes ?? 5
  const status = () => (info() ? notifyStatus(info()!.env) : undefined)
  // The hub's prefs come with the status; later edits replace them.
  const view = () => info()?.view
  const currentPrefs = () => prefs() ?? view()?.prefs
  const currentQuiet = () => (prefs() ? quiet() : (view()?.quietHours ?? null))
  const run = async (work: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await work()
      if (ok) toast(ok)
    } catch (e) {
      toast(errorText(e), "err")
    } finally {
      setBusy(false)
      setPrefs(undefined)
      void refetch()
    }
  }
  const save = async (change: Record<string, unknown>) => {
    try {
      const res = (await (await api("/api/push/prefs", { method: "PUT", json: change })).json()) as PushPrefsView
      setPrefs(res.prefs)
      setQuiet(res.quietHours ?? null)
      if (res.activityMinutes !== undefined) setMinutes(res.activityMinutes)
    } catch (e) {
      toast(errorText(e), "err")
    }
  }
  const test = async () => {
    setTestResult(undefined)
    try {
      setTestResult(describeTestResult(await sendTestNotification(testKind() || undefined)))
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e) })
    }
  }
  return (
    <Section id="notifications" title="Notifications">
      <Show when={status()} fallback={<p class="small muted">Checking this device…</p>}>
        {(s) => (
          <>
            <p class={s().warn ? "notify-status warn" : "notify-status ok"} data-state={s().state} role="status">
              {s().message}
            </p>
            <dl class="notify-facts small muted">
              <dt>Permission</dt>
              <dd>{info()!.env.supported ? info()!.env.permission : "unsupported"}</dd>
              <dt>Service worker</dt>
              <dd>{info()!.env.worker ? "registered" : "not registered"}</dd>
              <dt>Subscribed on this hub</dt>
              <dd>{info()!.env.hubSubscribed ? "yes" : "no"}</dd>
            </dl>
            <div class="row-actions">
              <Show when={s().action === "enable"}>
                <button type="button" class="btn small primary" disabled={busy()} onClick={() => void run(enableNotifications, "Notifications are on for this device")}>
                  Enable notifications on this device
                </button>
              </Show>
              <Show when={s().action === "disable"}>
                <button type="button" class="btn small" disabled={busy()} onClick={() => void run(disableNotifications, "Notifications are off for this device")}>
                  Turn off on this device
                </button>
              </Show>
              <Show when={info()!.env.hubSubscriptions > 0}>
                <span class="notify-test">
                  <select aria-label="Test notification kind" data-test-kind value={testKind()} onChange={(e) => setTestKind(e.currentTarget.value)}>
                    <option value="">Basic test</option>
                    <For each={NOTIFY_KINDS}>{(k) => <option value={k.key}>{k.label}</option>}</For>
                  </select>
                  <button type="button" class="btn small" onClick={() => void test()}>
                    Send test notification
                  </button>
                </span>
              </Show>
            </div>
            <Show when={testResult()}>{(r) => <p class={r().ok ? "small ok" : "small err"} data-test-result>{r().text}</p>}</Show>
          </>
        )}
      </Show>
      <Show when={currentPrefs()}>
        <h3>Notify me when</h3>
        <p class="small notify-summary" data-notify-summary>
          {notifySummary(currentPrefs()!)}
        </p>
        <Show when={status() && status()!.state !== "on"}>
          <p class="small warn">These apply once this device is subscribed.</p>
        </Show>
        <Show when={"activity" in currentPrefs()! && !currentPrefs()!.activity && !currentPrefs()!.done}>
          <p class="activity-hint" data-activity-hint>
            <strong>Know what happens with the screen off:</strong> turn on <em>All done</em> for one notification when a session and its subagents
            finish, or the <em>Activity digest</em> for one quiet, self-replacing summary per session.
          </p>
        </Show>
        <For each={NOTIFY_GROUPS}>
          {(group) => (
            <section class="notify-group" data-notify-group={group.title}>
              <h4>{group.title}</h4>
              <ul class="switches">
                <For each={group.kinds.filter((k) => k.key in currentPrefs()!)}>
                  {(kind) => (
                    <li>
                      <label class="switch">
                        <span class="notify-kind">
                          <span>{kind.label}</span>
                          <span class="small muted">{kind.description}</span>
                        </span>
                        <input type="checkbox" data-pref={kind.key} checked={!!currentPrefs()![kind.key]} onChange={(e) => void save({ [kind.key]: e.currentTarget.checked })} />
                      </label>
                      <Show when={kind.key === "activity" && currentPrefs()!.activity}>
                        <div class="quiet-hours">
                          <label>
                            At most one per session every{" "}
                            <select data-activity-minutes value={String(currentMinutes())} onChange={(e) => void save({ activityMinutes: Number(e.currentTarget.value) })}>
                              <For each={ACTIVITY_MINUTES}>{(m) => <option value={String(m)}>{m === 1 ? "minute" : `${m} minutes`}</option>}</For>
                            </select>
                          </label>
                          <span class="small muted">Collapses into one notification per session; respects quiet hours and muted sessions.</span>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
        <h4>When</h4>
        <ul class="switches">
          <li>
            <label class="switch">
              <span>Quiet hours</span>
              <input
                type="checkbox"
                checked={!!currentQuiet()}
                onChange={(e) => void save({ quietHours: e.currentTarget.checked ? { start: "22:00", end: "07:00", timeZone: localTimeZone() } : null })}
              />
            </label>
            <Show when={currentQuiet()}>
              {(q) => (
                <div class="quiet-hours">
                  <label>
                    From <input type="time" value={q().start} onChange={(e) => void save({ quietHours: { ...q(), start: e.currentTarget.value, timeZone: localTimeZone() } })} />
                  </label>
                  <label>
                    to <input type="time" value={q().end} onChange={(e) => void save({ quietHours: { ...q(), end: e.currentTarget.value, timeZone: localTimeZone() } })} />
                  </label>
                  <span class="small muted">{q().timeZone}. Hand-offs still come through.</span>
                </div>
              )}
            </Show>
          </li>
        </ul>
        <Show when={mutedSessions().size}>
          <p class="small muted">
            {plural(mutedSessions().size, "session")} muted (⋯ menu of a session → Unmute notifications).
          </p>
        </Show>
      </Show>
    </Section>
  )
}

function AppearanceSection() {
  return (
    <Section id="appearance" title="Appearance">
      <ul class="switches">
        <li class="speed">
          <label for="text-size">Text size</label>
          <input
            id="text-size"
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={textScale()}
            aria-valuetext={formatScale(textScale())}
            onInput={(e) => setTextScale(Number(e.currentTarget.value))}
          />
          <output for="text-size">{formatScale(textScale())}</output>
          <button type="button" class="btn small" aria-label="Reset text size" disabled={textScale() === FONT_SCALE_DEFAULT} onClick={() => setTextScale(FONT_SCALE_DEFAULT)}>
            Reset
          </button>
        </li>
      </ul>
      <p class="small muted">On this device. Pinch the conversation or the session list to change it too (a trackpad pinch works on desktop).</p>
    </Section>
  )
}

const SENSITIVITY_LABEL: Record<Sensitivity, string> = { low: "Low", normal: "Normal", high: "High" }

function VoiceSection() {
  const [speed, setSpeed] = createSignal(voicePrefs.speed)
  const [sensitivity, setSensitivity] = createSignal(voicePrefs.sensitivity)
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
          <div class="switch">
            <span id="voice-sensitivity">Mic sensitivity</span>
            <div class="chips" role="radiogroup" aria-labelledby="voice-sensitivity">
              <For each={SENSITIVITIES}>
                {(level) => (
                  <button
                    type="button"
                    class="chip"
                    role="radio"
                    aria-checked={sensitivity() === level}
                    aria-pressed={sensitivity() === level}
                    onClick={() => {
                      voicePrefs.sensitivity = level
                      setSensitivity(level)
                    }}
                  >
                    {SENSITIVITY_LABEL[level]}
                  </button>
                )}
              </For>
            </div>
          </div>
          <p class="small muted">
            How sure Voice mode must be that you are speaking to it. Low: noisy places (only clear, sustained speech counts). High: quiet rooms and soft voices. On this device; applies at once, also while Voice mode is on.
          </p>
        </li>
        <li>
          <label class="switch">
            <span>Progress cues</span>
            <input type="checkbox" checked={voicePrefs.cues} onChange={(e) => (voicePrefs.cues = e.currentTarget.checked)} />
          </label>
          <p class="small muted">In Voice mode: a soft tone when the agent hears you, then short, varied acknowledgements while it works (“On it.”, “One moment.”, “I’ll hand that off.”, “Still on it.” …).</p>
        </li>
        <li>
          <label class="switch">
            <span>Keep listening when the screen is off</span>
            <input type="checkbox" checked={voicePrefs.background} onChange={(e) => (voicePrefs.background = e.currentTarget.checked)} />
          </label>
          <p class="small muted">Off: the screen stays on while listening. On: lock-screen controls and listening with the screen off. Best effort. Android Chrome usually stops the microphone when the screen turns off; Hub shows when listening is paused and resumes when you unlock. Applies the next time Voice mode starts.</p>
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

type DeviceRow = { id: string; name: string; lastSeen: number; current?: boolean }

function DevicesSection() {
  const [devices, { refetch, mutate }] = createResource(() => getJSON("/api/devices").then((r) => r.devices as DeviceRow[]))
  const [adding, setAdding] = createSignal(false)
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
      <div class="row">
        <p class="small muted grow">Browsers and the Hub app signed in to your account. Add the app on a phone or tablet by scanning a code.</p>
        <button type="button" class="btn small" onClick={() => setAdding(true)}>
          Add app
        </button>
      </div>
      <Show when={adding()}>
        <AddAppDialog
          known={new Set((devices() ?? []).map((d) => d.id))}
          onLinked={(list) => mutate(list)}
          onClose={() => {
            setAdding(false)
            void refetch()
          }}
        />
      </Show>
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

/** Interval of the device list refresh while the Add app dialog waits for the app to redeem its code. */
const LINK_POLL_MS = 2000

/**
 * Settings → Devices → Add app: a single-use link code (POST /api/devices/link) as a QR code and a hubapp:// link,
 * with its countdown. The app redeems it for its own device token; the dialog notices the new device (polling
 * the device list), names it and closes.
 */
function AddAppDialog(props: { known: ReadonlySet<string>; onLinked: (devices: DeviceRow[]) => void; onClose: () => void }) {
  /** expiresAt: on this device's clock (see linkDeadline). */
  const [link, setLink] = createSignal<{ code: string; expiresAt: number; hub: string; url: string }>()
  const [failed, setFailed] = createSignal("")
  const [clock, setClock] = createSignal(Date.now())
  const issue = async () => {
    setFailed("")
    try {
      const res = await api("/api/devices/link", { method: "POST", json: {} })
      const body = (await res.json()) as { code: string; expiresAt: number; hub: string; url: string }
      const t = Date.now()
      setClock(t)
      setLink({ ...body, expiresAt: linkDeadline(body.expiresAt, res.headers.get("date"), t) })
    } catch (e) {
      setFailed(errorText(e))
    }
  }
  const expired = () => (link()?.expiresAt ?? 0) <= clock()
  const qr = () => {
    const l = link()
    return l ? qrCode(l.url, { ecc: "M" }) : undefined
  }
  const tick = setInterval(() => setClock(Date.now()), 1000)
  let polling = false
  const poll = setInterval(async () => {
    if (polling || !link() || expired()) return
    polling = true
    try {
      const list = (await getJSON("/api/devices")).devices as DeviceRow[]
      const added = linkedDevice(props.known, list)
      if (added) {
        props.onLinked(list)
        toast(`${added.name} linked`)
        props.onClose()
      }
    } catch {
      // keep waiting; the next poll retries
    } finally {
      polling = false
    }
  }, LINK_POLL_MS)
  onCleanup(() => {
    clearInterval(tick)
    clearInterval(poll)
  })
  void issue()
  return (
    <Dialog open title="Add the Hub app" onClose={props.onClose} class="add-app">
      <Show when={link()} fallback={<p class="small muted">{failed() || "Creating a link code…"}</p>}>
        {(l) => (
          <div class="add-app-body">
            <p class="small">
              In the Hub app, choose <b>Add hub</b> and scan this code, or open the link on the phone with the app. It links the app to your account on{" "}
              <b>{l().hub}</b>.
            </p>
            <Show
              when={!expired()}
              fallback={
                <div class="add-app-expired">
                  <p class="small warn">This code expired.</p>
                  <button type="button" class="btn small primary" onClick={() => void issue()}>
                    New code
                  </button>
                </div>
              }
            >
              <svg class="qr" role="img" aria-label="QR code for the app link" viewBox={`0 0 ${qr()!.size + 8} ${qr()!.size + 8}`} shape-rendering="crispEdges">
                <rect width="100%" height="100%" fill="#fff" />
                <path d={qrSvgPath(qr()!, 4)} fill="#000" />
              </svg>
              <p class="small muted">
                Expires in <span class="add-app-countdown">{linkCountdown(l().expiresAt, clock())}</span> · single use
              </p>
              <div class="row">
                <code class="add-app-link grow">{l().url}</code>
                <button
                  type="button"
                  class="btn small"
                  onClick={() =>
                    void navigator.clipboard?.writeText(l().url).then(
                      () => toast("Link copied"),
                      () => toast("Copy failed", "err"),
                    )
                  }
                >
                  Copy
                </button>
                <a class="btn small" href={l().url}>
                  Open
                </a>
              </div>
            </Show>
            <p class="small muted">Anyone with this code can sign in as you until it is used or expires; show it only to your own device.</p>
          </div>
        )}
      </Show>
    </Dialog>
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
