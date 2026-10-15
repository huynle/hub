import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"
import { isLoopbackURL } from "./loopback"
import { HubRpc } from "./rpc"
import { localServerFor, modeFor, needsSetup, parseServerInput, setupOptions, type SetupChoice } from "./setup"
import { PresenceReporter, shownSessions } from "./tui-presence"

// /hub (alias /voice): first-run setup (a hub on this computer, or your own hub), then one dialog to choose
// what this machine shares and to open sessions on this device or a phone. Links are shown here, never
// posted into the session, so they do not reach the model. Decisions live in src/setup.ts (tested).

type Mode = "off" | "always" | "session"
interface Status {
  server: string
  mode: Mode
  enrolled: boolean
  connection: "off" | "connecting" | "connected" | "revoked" | "error"
  lastError?: string
  sessionExposed?: boolean
  conversation?: boolean
  enrollment?: "pending" | "approved" | "denied" | "expired" | "error"
  machineName: string
  /** Why the local hub could not be started. */
  localHub?: string
}

interface Enrolled {
  userCode: string
  approveURL: string
  autoApproved?: boolean
  localHub?: "started" | "running" | "busy"
}

type Choice = "talk" | "ui" | "send" | "conversation" | "toggle" | "mode" | "pair" | "server"

const MODE_LABEL: Record<Mode, string> = { always: "Always", session: "This session only", off: "Off" }

const HUB_LOG = "~/.local/state/opencode-hub/hub.log"
const host = (server: string) => server.replace(/^https?:\/\//, "")

function describeStatus(status: Status): string {
  const where = host(status.server)
  const state = !status.enrolled
    ? `not connected to ${where}`
    : status.connection === "connected"
      ? `connected to ${status.server}`
      : status.connection === "connecting"
        ? `connecting to ${where}…`
        : status.connection === "revoked"
          ? `revoked by ${where}`
          : status.connection === "error"
            ? `cannot reach ${where}`
            : `${where}`
  return `OpenCode Hub · ${state} · mode: ${MODE_LABEL[status.mode]}`
}

export default Plugin.define({
  id: "opencode-hub.tui",
  setup(context) {
    const hub = context.client.rpc(HubRpc) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
    const call = async <T>(method: string, input: Record<string, unknown> = {}) =>
      (await hub[method]!(input, { location: context.location ?? context.data.location.default() })) as T
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "OpenCode Hub", message, variant })
    const currentSession = () => {
      const route = context.ui.router.current() as { type: string; sessionID?: string }
      return route.type === "session" ? route.sessionID : undefined
    }
    const status = (sessionID = currentSession()) => call<Status>("status", sessionID ? { sessionID } : {})

    /** Polls status until `done` holds; undefined when the time runs out. */
    const waitFor = async (done: (s: Status) => boolean, ms: number, every = 300) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const s = await status().catch(() => undefined)
        if (s && done(s)) return s
        await Bun.sleep(every)
      }
      return undefined
    }

    /** Opens a one-time sign-in link in the browser; shows it when no browser could be opened. */
    const showLink = async (url: string, what: string) => {
      const opened = openURL(url)
      const copied = copyToClipboard(url)
      if (opened) return toast(`Opened ${what} in your browser${copied ? " (link copied)" : ""}`, "success")
      await context.ui.dialog.alert({ title: "OpenCode Hub", message: `Open this link${copied ? " (copied)" : ""}:\n\n${url}\n\nKeep it private.` })
    }

    const talkHere = async (sessionID: string) => {
      const { url } = await call<{ url: string }>("openLink", { sessionID })
      await showLink(url, "this session's page")
    }

    /**
     * The hub page (the session's when it is shared, else the home page). A local hub is started first
     * when nothing answers; the hub lands on speech setup while no speech provider is usable.
     */
    const openUI = async (sessionID?: string) => {
      let s = await status(sessionID)
      if (s.connection !== "connected") {
        if (!s.enrolled) throw new Error("This machine is not connected to a hub yet. Run /hub to set it up.")
        if (s.mode === "off") throw new Error("Sharing is off for this machine. Run /hub → Mode first.")
        if (isLoopbackURL(s.server)) {
          const { status: started } = await call<{ status: string }>("startLocalHub")
          if (started === "started") toast(`Started the local hub (log: ${HUB_LOG})`)
        }
        toast(`Connecting to ${host(s.server)}…`)
        if (!(await waitFor((x) => x.connection === "connected", 20_000))) {
          s = await status(sessionID)
          throw new Error(`Could not connect to ${s.server}${s.localHub ? `: ${s.localHub}` : s.lastError ? `: ${s.lastError}` : ""}`)
        }
        s = await status(sessionID)
      }
      const shared = sessionID && s.sessionExposed ? sessionID : undefined
      const { url } = await call<{ url: string }>("openLink", shared ? { sessionID: shared } : {})
      await showLink(url, "the hub")
    }

    const sendToPhone = async (sessionID: string) => {
      const { notified } = await call<{ notified: number }>("handoff", { sessionID })
      if (notified > 0) toast(`Notified ${notified} device${notified === 1 ? "" : "s"}`, "success")
      else toast("No phone is paired yet. Use /hub → Pair a phone first.", "warning")
    }

    const toggleConversation = async (sessionID: string, s: Status) => {
      const on = !s.conversation
      const { agent } = await call<{ agent: string }>("conversation", { sessionID, on })
      if (!on) return toast(`Conversation mode off (agent: ${agent})`, "success")
      const connected = s.connection === "connected"
      const go = await context.ui.dialog.confirm({
        title: "Conversation mode on",
        message:
          `This session now runs the ${agent} agent: short spoken replies, real work handed to background subagents. ` +
          `Open this session on your phone to talk${connected ? "" : " once this machine is connected"}.`,
        label: { confirm: connected ? "Send to phone" : "OK", cancel: "Later" },
      })
      if (go && connected) await sendToPhone(sessionID)
    }

    /** Sets the mode; "This session only" switches the current session on. Returns a note for the toast. */
    const applyMode = async (mode: Mode) => {
      await call("setMode", { mode })
      const sessionID = currentSession()
      if (mode === "session" && sessionID) await call("setSession", { sessionID, on: true })
      return mode === "session" && sessionID ? " (this session is on)" : ""
    }

    const chooseMode = async (s: Status, title = "Which sessions can the hub see?") => {
      const mode = await context.ui.dialog.select<Mode>({
        title,
        current: s.mode === "off" ? "always" : s.mode,
        options: [
          { title: "Always", value: "always", description: "Every session in this OpenCode process" },
          { title: "This session only", value: "session", description: "Only sessions you switch on with /hub" },
          { title: "Off", value: "off", description: "Disconnect this process from the hub" },
        ],
      })
      if (!mode || mode === s.mode) return
      const note = await applyMode(mode)
      toast(`Hub mode: ${MODE_LABEL[mode]}${note}`, "success")
    }

    const pairPhone = async () => {
      const { code, url, expiresAt } = await call<{ code: string; url: string; expiresAt: number }>("pairCode")
      const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))
      copyToClipboard(url)
      await context.ui.dialog.alert({
        title: "Pair a phone",
        message: `On your phone, open:\n\n${url}\n\nand enter the code ${code} (valid ~${minutes} min).`,
      })
    }

    /** Waits in the background for the server's decision, then asks which sessions to share. */
    const watchEnrollment = async () => {
      const failed = (s: Status) => s.enrollment === "denied" || s.enrollment === "expired" || s.enrollment === "error"
      const done = await waitFor((s) => failed(s) || s.enrolled, 15 * 60_000, 2000)
      if (!done) return
      if (failed(done)) return toast(`Approval ${done.enrollment}. Run /hub to try again.`, "error")
      if (done.mode !== "off") return toast(`Approved by ${host(done.server)}. The hub is set up.`, "success")
      toast(`Approved by ${host(done.server)}.`, "success")
      await chooseMode(done, "Approved. Which sessions can the hub see?")
      const after = await status().catch(() => undefined)
      if (after && after.mode !== "off") toast("The hub is set up. /hub → Open hub, or Talk on this device.", "success")
    }

    /** Device-code approval: open the approve page, say what to look for, and watch for the result. */
    const awaitApproval = async (enrolled: Enrolled, s: Status) => {
      const opened = openURL(enrolled.approveURL)
      copyToClipboard(enrolled.approveURL)
      void watchEnrollment()
      toast(`Approve "${s.machineName}" (code ${enrolled.userCode}) in the browser`)
      await context.ui.dialog.alert({
        title: `Approve "${s.machineName}"`,
        message:
          `${opened ? "Opened in your browser" : "Open"}:\n\n${enrolled.approveURL}\n\n` +
          `Check the code ${enrolled.userCode} and approve. A browser that is not paired with ${host(s.server)} yet asks for a ` +
          `pairing code first: /hub → Pair a phone on a connected computer, or the code in the hub's log for the very first device. ` +
          `You'll get a notice here once it is approved.`,
      })
    }

    // ---------- first-run setup ----------

    /** A hub on this computer: start it, enroll (a fresh local hub approves at once), share, open the page. */
    const setupLocal = async (s: Status, choice: SetupChoice) => {
      const server = localServerFor(s.server)
      if (server !== s.server) await call("setServer", { server })
      toast("Starting the local hub…")
      const enrolled = await call<Enrolled>("enroll")
      if (enrolled.localHub === "started") toast(`Started the local hub (log: ${HUB_LOG})`)
      if (!enrolled.autoApproved) {
        // This hub already knows other machines or devices: approve it like a remote server.
        await applyMode(modeFor(choice))
        return awaitApproval(enrolled, { ...s, server })
      }
      if (!(await waitFor((x) => x.enrolled, 15_000))) {
        throw new Error(`The local hub approved this machine, but it did not connect. See ${HUB_LOG}`)
      }
      const note = await applyMode(modeFor(choice))
      toast(`Connected to the local hub · mode: ${MODE_LABEL[modeFor(choice)]}${note}`, "success")
      await openUI(currentSession())
    }

    /** Your own hub: check that it answers, save it, enroll, approve in the browser, then pick a mode. */
    const setupRemote = async (s: Status, server: string) => {
      const health = await call<{ ok: boolean; version?: string; error?: string }>("checkServer", { server })
      if (!health.ok) {
        await context.ui.dialog.alert({ title: "Hub not reachable", message: health.error ?? `Could not reach ${server}` })
        return
      }
      if (server !== s.server) await call("setServer", { server })
      const enrolled = await call<Enrolled>("enroll")
      await awaitApproval(enrolled, { ...s, server })
    }

    const promptServer = async (s: Status): Promise<string | undefined> => {
      let value = isLoopbackURL(s.server) ? "" : s.server
      for (;;) {
        const raw = await context.ui.dialog.prompt({
          title: "Hub URL",
          description: "The address of a hub you or your team host. Changing it disconnects this machine from the current server.",
          value,
          placeholder: "https://hub.example.com",
        })
        if (raw === undefined || raw === null) return undefined
        const parsed = parseServerInput(raw)
        if (parsed.ok) return parsed.url
        toast(parsed.error, "error")
        value = raw
      }
    }

    const runSetup = async (s: Status) => {
      const choice = await context.ui.dialog.select<SetupChoice>({
        title: s.enrolled && s.connection === "revoked" ? `Set up OpenCode Hub · revoked by ${host(s.server)}` : "Set up OpenCode Hub",
        options: setupOptions(s).map((o) => ({ title: o.title, value: o.value, description: o.description })),
      })
      switch (choice) {
        case "local":
        case "local-session":
          return setupLocal(s, choice)
        case "configured":
          return setupRemote(s, s.server)
        case "remote": {
          const server = await promptServer(s)
          if (server) await setupRemote(s, server)
          return
        }
      }
    }

    // ---------- regular menu ----------

    const changeServer = async (s: Status) => {
      const pick = await context.ui.dialog.select<"current" | "setup">({
        title: `Hub: ${s.server}`,
        current: "current",
        options: [
          { title: `Keep ${host(s.server)}`, value: "current", description: "No change" },
          { title: "Set up again…", value: "setup", description: "This computer or another hub (disconnects this machine from the current one)" },
        ],
      })
      if (pick === "setup") await runSetup({ ...s, enrolled: false })
    }

    const open = async () => {
      const sessionID = currentSession()
      const s = await status(sessionID)
      if (needsSetup(s)) return runSetup(s)
      const connected = s.connection === "connected"
      const local = isLoopbackURL(s.server)
      const options: Array<{ title: string; value: Choice; description?: string }> = []

      if (connected && sessionID && s.sessionExposed) {
        options.push({ title: "Talk on this device", value: "talk", description: "Open this session in the browser" })
        options.push({ title: "Send to phone", value: "send", description: "Notify your paired phones" })
      }
      if (s.mode !== "off" && (connected || local)) {
        options.push({
          title: connected ? "Open hub" : "Start local hub / Open hub",
          value: "ui",
          description: connected ? "Every session, plus settings (speech provider and keys), in the browser" : "Starts the hub on this computer, then opens it",
        })
      }
      if (sessionID && s.sessionExposed) {
        options.push({
          title: `Conversation mode: ${s.conversation ? "on" : "off"}`,
          value: "conversation",
          description: s.conversation
            ? "Switch this session back to its previous agent"
            : "Voice orchestrator for this session: short replies, work goes to background subagents",
        })
      }
      if (s.mode === "session" && sessionID) {
        options.push({
          title: `This session: ${s.sessionExposed ? "on" : "off"}`,
          value: "toggle",
          description: s.sessionExposed ? "Stop sharing this session with the hub" : "Share this session with the hub",
        })
      }
      options.push({ title: `Mode: ${MODE_LABEL[s.mode]}`, value: "mode", description: "Always / This session only / Off" })
      if (connected) options.push({ title: "Pair a phone", value: "pair", description: "Show a pairing code for a new device" })
      options.push({ title: `Server: ${host(s.server)}`, value: "server", description: "Set up again: this computer or another hub" })

      let title = describeStatus(s)
      if (s.connection === "error" && s.localHub) title += ` (local hub: ${s.localHub})`
      else if (s.connection === "error" && s.lastError) title += ` (${s.lastError})`
      else if (s.mode === "off") title += " · choose a mode to start"
      else if (connected && sessionID && !s.sessionExposed) title += " · this session is not shared"

      const choice = await context.ui.dialog.select<Choice>({ title, options })
      switch (choice) {
        case "talk":
          return talkHere(sessionID!)
        case "ui":
          return openUI(sessionID)
        case "send":
          return sendToPhone(sessionID!)
        case "conversation":
          return toggleConversation(sessionID!, s)
        case "toggle":
          await call("setSession", { sessionID, on: !s.sessionExposed })
          return toast(`This session is ${s.sessionExposed ? "no longer shared" : "shared"} with the hub`, "success")
        case "mode":
          return chooseMode(s)
        case "pair":
          return pairPhone()
        case "server":
          return changeServer(s)
      }
    }

    // Presence: tell the server-side spoke which sessions this TUI shows, so the phone lists them as open.
    const reporter = `tui_${Math.random().toString(36).slice(2, 12)}`
    const presence = new PresenceReporter({
      read: () =>
        shownSessions({
          route: context.ui.router.current() as { type: string; sessionID?: string },
          root: (id) => context.data.session.root(id),
          tabs: context.ui.tabs.enabled() ? context.ui.tabs.list().map((t) => t.sessionID) : [],
        }),
      send: (sessionIDs) => call("presence", { sessionIDs: [...sessionIDs], reporter }),
    })
    presence.start()

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-hub.open",
          title: "OpenCode Hub: set up, share, and open this session remotely",
          group: "OpenCode Hub",
          palette: true,
          // /voice was the opencode-voice command; kept as an alias with the same behavior.
          slash: { name: "hub", aliases: ["voice"] },
          run: () =>
            void open().catch((cause) => {
              toast(errorMessage(cause), "error")
            }),
        },
      ],
    }))
    return () => presence.stop()
  },
})

// RPC failures arrive as plain objects ({ type, message, data }), not Error instances.
function errorMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

function openURL(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : process.platform === "win32" ? "explorer" : undefined
  if (!command) return false
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function copyToClipboard(text: string): boolean {
  if (process.platform !== "darwin") return false
  try {
    const child = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.end(text)
    return true
  } catch {
    return false
  }
}
