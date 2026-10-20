// The console shell: sidebar + routed main area; /pair and /approve render outside it.
import { Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { Approve, Pair } from "./Entry"
import { Home } from "./Home"
import { ensureMe, hub, loadSpeechReady, me, startEvents } from "./hub"
import { drawerOpen, isPhone, setDrawerOpen, shownWidths, sidebarCollapsed, toggleSidebar } from "./layout"
import { PanelHandle } from "./PanelHandle"
import { NewSession } from "./NewSession"
import { syncPush } from "./push"
import { navigate, route } from "./router"
import { SessionView } from "./Session"
import { Settings } from "./Settings"
import { dictation, voiceState } from "./voice"
import { VoicePill } from "./VoicePill"
import { Sidebar } from "./Sidebar"
import { currentToast, dismissToast } from "./toast"
import { IconButton } from "./ui"
import { installPinchZoom } from "./text-size"

export function App() {
  const [error, setError] = createSignal("")
  const [ready, setReady] = createSignal(false)
  const boot = async () => {
    setError("")
    try {
      if (!(await ensureMe())) return
      startEvents()
      void loadSpeechReady()
      void syncPush()
      setReady(true)
    } catch (e) {
      setError(`Cannot reach the hub: ${(e as Error).message}`)
    }
  }
  createEffect(
    on(
      () => route().name,
      (name) => {
        if (name !== "pair" && !ready()) void boot()
        if (isPhone()) setDrawerOpen(false)
      },
    ),
  )
  createEffect(() => {
    if (!me() && ready() && route().name !== "pair") setReady(false)
  })
  // A dictation belongs to the session it was started in: leaving that session cancels it.
  createEffect(() => {
    const r = route()
    dictation.viewing(r.name === "session" ? r.id : undefined)
  })
  // Pinch on the transcript or the sessions list: text size, not page zoom.
  onMount(() => onCleanup(installPinchZoom()))
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
  // Panel widths (desktop): CSS variables on the root, so a drag only restyles the two panels.
  createEffect(() => {
    const w = shownWidths()
    const root = document.documentElement.style
    root.setProperty("--side-w", `${w.side}px`)
    root.setProperty("--rail-w", `${w.rail}px`)
  })
  // One-time sign-in links land on #speech when speech still needs setting up.
  createEffect(() => {
    if (ready() && location.hash === "#speech" && route().name !== "settings") navigate("/settings#speech", { replace: true })
  })
  return (
    <>
      <Switch>
        <Match when={route().name === "pair" && route()}>{(r) => <Pair next={(r() as { next: string }).next} error={(r() as { error: string }).error} />}</Match>
        <Match when={error()}>
          <main class="entry">
            <p>{error()}</p>
            <button type="button" class="btn" onClick={() => void boot()}>
              Retry
            </button>
          </main>
        </Match>
        <Match when={!ready()}>
          <main class="entry">
            <p class="muted">Loading…</p>
          </main>
        </Match>
        <Match when={route().name === "approve" && route()}>{(r) => <Approve code={(r() as { code: string }).code} />}</Match>
        <Match when={true}>
          <div class={`shell${sidebarCollapsed() && !isPhone() ? " collapsed" : ""}${isPhone() ? " phone" : ""}${drawerOpen() ? " drawer" : ""}`}>
            <Show when={!isPhone() || drawerOpen()}>
              <Show when={isPhone()}>
                <div class="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
              </Show>
              <Show when={!sidebarCollapsed() || isPhone()}>
                <Sidebar phone={isPhone()} onClose={() => setDrawerOpen(false)} onCollapse={toggleSidebar} />
                <Show when={!isPhone()}>
                  <PanelHandle panel="side" label="Resize sidebar" />
                </Show>
              </Show>
            </Show>
            <main class="main">
              <Show when={sidebarCollapsed() && !isPhone()}>
                <IconButton icon="sidebar" label="Show sidebar (⌘B)" class="expand-sidebar" onClick={toggleSidebar} />
              </Show>
              <Show when={voiceState().phase !== "off" && route().name !== "session"}>
                <div class="voice-strip">
                  <VoicePill />
                </div>
              </Show>
              <Show when={hub.connection === "down"}>
                <div class="conn-banner" role="status">
                  Reconnecting to the hub…
                </div>
              </Show>
              <Switch>
                <Match when={route().name === "session" && route()} keyed>
                  {(r) => <SessionView id={(r as { id: string }).id} />}
                </Match>
                <Match when={route().name === "new" && route()}>{(r) => <NewSession {...(r() as { machine?: string; dir?: string; key?: string })} />}</Match>
                <Match when={route().name === "settings"}>
                  <Settings />
                </Match>
                <Match when={true}>
                  <HomeShell />
                </Match>
              </Switch>
            </main>
          </div>
        </Match>
      </Switch>
      <Show when={currentToast()}>
        {(t) => (
          <div class={`toast ${t().kind}`} role="status" aria-live="polite">
            <span>{t().text}</span>
            <Show when={t().action}>
              <button
                type="button"
                class="btn small"
                onClick={() => {
                  t().action!.run()
                  dismissToast()
                }}
              >
                {t().action!.label}
              </button>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

function HomeShell() {
  return (
    <div class="home-shell">
      <Show when={isPhone()}>
        <header class="topbar">
          <IconButton icon="menu" label="Open sidebar" onClick={toggleSidebar} />
          <span class="title display">Hub</span>
        </header>
      </Show>
      <div class="home-scroll">
        <Home />
      </div>
    </div>
  )
}
