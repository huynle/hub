// /hub and /voice in the TUI: two separate commands (src/tui.ts), and the /voice flow (src/voice-command.ts):
// set up or connect the hub when needed, share the session for Voice, open the browser on it with ?voice=1.
import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../src/tui"
import { startVoice, type VoiceCommandDeps, type VoiceStatus } from "../src/voice-command"

/** The commands src/tui.ts registers, with a fake TUI context (nothing is run). */
function registeredCommands() {
  const layers: Array<() => { commands: any[] }> = []
  const context: any = {
    client: { rpc: () => new Proxy({}, { get: () => async () => ({}) }) },
    location: undefined,
    data: { location: { default: () => undefined }, session: { root: (id: string) => id } },
    ui: {
      toast: { show: () => {} },
      router: { current: () => ({ type: "home" }) },
      dialog: { alert: async () => {}, confirm: async () => false, select: async () => undefined, prompt: async () => undefined },
      tabs: { enabled: () => false, list: () => [] },
    },
    keymap: { layer: (fn: () => { commands: any[] }) => layers.push(fn) },
  }
  const dispose = (plugin as any).setup(context)
  const commands = layers.flatMap((fn) => fn().commands)
  if (typeof dispose === "function") dispose()
  return commands
}

async function until(done: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** The TUI plugin with a fake context on `route`: RPC calls are recorded; `fail` makes a method reject. */
function tuiWith(route: { type: string; sessionID?: string }, fail: Record<string, unknown> = {}) {
  const layers: Array<() => { commands: any[] }> = []
  const calls: Array<[string, unknown]> = []
  const toasts: Array<{ title: string; message: string; variant: string }> = []
  const alerts: Array<{ title: string; message: string }> = []
  const answers: Record<string, unknown> = {
    hubMsg: { id: "m_1", to: "@bob", delivery: "queued" },
    hubWho: { sessions: [{ sessionID: "ses_bob", name: "bob", project: "hub", online: true, roles: [] }] },
    formActions: { actions: [] },
  }
  const rpc = new Proxy(
    {},
    {
      get: (_target, method: string) => async (input: unknown) => {
        calls.push([method, input])
        if (method === "formActions") await Bun.sleep(50)
        if (method in fail) throw fail[method]
        return answers[method] ?? {}
      },
    },
  )
  const context: any = {
    client: { rpc: () => rpc },
    location: undefined,
    data: { location: { default: () => undefined }, session: { root: (id: string) => id } },
    ui: {
      toast: { show: (t: (typeof toasts)[number]) => void toasts.push(t) },
      router: { current: () => route },
      dialog: { alert: async (a: (typeof alerts)[number]) => void alerts.push(a), confirm: async () => false, select: async () => undefined, prompt: async () => undefined },
      tabs: { enabled: () => false, list: () => [] },
    },
    keymap: { layer: (fn: () => { commands: any[] }) => layers.push(fn) },
  }
  const dispose = (plugin as any).setup(context)
  cleanups.push(() => typeof dispose === "function" && dispose())
  const commands = layers.flatMap((fn) => fn().commands)
  return { calls, toasts, alerts, command: (name: string) => commands.find((c) => c.slash?.name === name)! }
}

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe("TUI commands", () => {
  test("/hub and /voice are separate commands; no name or alias is registered twice", () => {
    const commands = registeredCommands()
    const slash = commands.map((c) => c.slash?.name)
    expect(slash).toContain("hub")
    expect(slash).toContain("voice")
    const hub = commands.find((c) => c.slash?.name === "hub")!
    const voice = commands.find((c) => c.slash?.name === "voice")!
    expect(hub.id).not.toBe(voice.id)
    const names = commands.flatMap((c) => [c.slash?.name, ...(c.slash?.aliases ?? [])]).filter(Boolean)
    expect(new Set(names).size).toBe(names.length)
    expect(hub.slash.aliases ?? []).not.toContain("voice")
    expect(typeof voice.run).toBe("function")
    expect(hub).toMatchObject({ id: "hub.open", group: "Hub" })
    expect(voice).toMatchObject({ id: "hub.voice", group: "Hub" })
  })

  test("/who and /msg take arguments; /hub and /voice do not", () => {
    const commands = registeredCommands()
    const who = commands.find((c) => c.slash?.name === "who")!
    const msg = commands.find((c) => c.slash?.name === "msg")!
    expect(who).toMatchObject({ id: "hub.who", group: "Hub", slash: { name: "who", arguments: true } })
    expect(msg).toMatchObject({ id: "hub.msg", group: "Hub", slash: { name: "msg", arguments: true } })
    expect(commands.find((c) => c.slash?.name === "hub")!.slash.arguments).toBeUndefined()
    expect(commands.find((c) => c.slash?.name === "voice")!.slash.arguments).toBeUndefined()
  })

  test("/msg @x text calls hubMsg word for word as the current session; on the home screen it is a toast", async () => {
    const inSession = tuiWith({ type: "session", sessionID: "ses_me" })
    inSession.command("msg").run('@bob  hello "you"')
    await until(() => inSession.toasts.length > 0)
    expect(inSession.calls).toContainEqual(["hubMsg", { sessionID: "ses_me", to: "@bob", text: 'hello "you"' }])
    expect(inSession.toasts).toContainEqual({ title: "Hub", message: "Sent to @bob (queued)", variant: "success" })

    const home = tuiWith({ type: "home" })
    home.command("msg").run("@bob hi")
    await until(() => home.toasts.length > 0)
    expect(home.calls.filter(([method]) => method === "hubMsg")).toEqual([])
    expect(home.toasts[0]).toMatchObject({ variant: "warning", message: expect.stringMatching(/open a session/i) })
  })

  test("/who lists the hub's sessions in a dialog as the current session; RPC errors are toasts", async () => {
    const tui = tuiWith({ type: "session", sessionID: "ses_me" })
    tui.command("who").run("hub")
    await until(() => tui.alerts.length > 0)
    expect(tui.calls).toContainEqual(["hubWho", { sessionID: "ses_me", project: "hub" }])
    expect(tui.alerts[0]!.message).toBe("@bob · hub · online")

    const failing = tuiWith({ type: "session", sessionID: "ses_me" }, { hubMsg: { type: "not_connected", message: "This session has no hub token yet" } })
    failing.command("msg").run("@bob hi")
    await until(() => failing.toasts.length > 0)
    expect(failing.toasts[0]).toMatchObject({ variant: "error", message: "This session has no hub token yet" })
  })

  test("is the hub.tui plugin", () => {
    expect((plugin as any).id).toBe("hub.tui")
  })
})

const connected: VoiceStatus = { server: "https://hub.example.com", mode: "always", enrolled: true, connection: "connected", sessionExposed: true }

function fakes(statuses: VoiceStatus[], over: Partial<VoiceCommandDeps> = {}) {
  const log: string[] = []
  let i = 0
  const deps: VoiceCommandDeps = {
    sessionID: () => "ses_1",
    status: async () => statuses[Math.min(i++, statuses.length - 1)]!,
    setup: async () => void log.push("setup"),
    chooseMode: async () => void log.push("mode"),
    connect: async (s) => (log.push("connect"), { ...s, connection: "connected" }),
    expose: async (id) => void log.push(`expose ${id}`),
    openLink: async (id, voice) => (log.push(`openLink ${id} ${voice}`), { url: `https://hub.example.com/login?code=c&next=/s/${id}?voice=1` }),
    showLink: async (url) => void log.push(`show ${url}`),
    toast: (message, variant) => void log.push(`toast ${variant}: ${message}`),
    ...over,
  }
  return { deps, log }
}

describe("/voice", () => {
  test("connected and shared: opens the session with Voice mode, no menu", async () => {
    const { deps, log } = fakes([connected])
    expect(await startVoice(deps)).toBe("opened")
    expect(log).toEqual(["openLink ses_1 true", "show https://hub.example.com/login?code=c&next=/s/ses_1?voice=1"])
  })

  test("a session not shared with Voice is exposed first", async () => {
    const { deps, log } = fakes([{ ...connected, mode: "session", sessionExposed: false }])
    expect(await startVoice(deps)).toBe("opened")
    expect(log.slice(0, 2)).toEqual(["expose ses_1", "openLink ses_1 true"])
  })

  test("not set up: runs the /hub setup, then continues once connected", async () => {
    const fresh: VoiceStatus = { server: "http://127.0.0.1:4097", mode: "off", enrolled: false, connection: "off" }
    const { deps, log } = fakes([fresh, { ...connected, mode: "session", sessionExposed: false }])
    expect(await startVoice(deps)).toBe("opened")
    expect(log.slice(0, 3)).toEqual(["setup", "expose ses_1", "openLink ses_1 true"])
  })

  test("setup left unfinished (e.g. approval pending): stops with a hint", async () => {
    const fresh: VoiceStatus = { server: "https://hub.example.com", mode: "off", enrolled: false, connection: "off" }
    const { deps, log } = fakes([fresh, fresh])
    expect(await startVoice(deps)).toBe("not-set-up")
    expect(log[0]).toBe("setup")
    expect(log.at(-1)).toMatch(/^toast warning: .*\/voice again/)
    expect(log.some((l) => l.startsWith("openLink"))).toBe(false)
  })

  test("sharing off: asks for a mode; still off → stops", async () => {
    const off = { ...connected, mode: "off" as const, connection: "off" as const }
    const { deps, log } = fakes([off, off])
    expect(await startVoice(deps)).toBe("off")
    expect(log[0]).toBe("mode")
    expect(log.some((l) => l.startsWith("openLink"))).toBe(false)
  })

  test("enrolled but not connected: connects (starting a local hub) first", async () => {
    const { deps, log } = fakes([{ ...connected, connection: "error" }])
    expect(await startVoice(deps)).toBe("opened")
    expect(log[0]).toBe("connect")
  })

  test("no session on screen: a hint, nothing else", async () => {
    const { deps, log } = fakes([connected], { sessionID: () => undefined })
    expect(await startVoice(deps)).toBe("no-session")
    expect(log).toEqual([expect.stringMatching(/^toast warning: Open a session/)])
  })
})
