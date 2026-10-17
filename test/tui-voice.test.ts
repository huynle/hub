// /hub and /voice in the TUI: two separate commands (src/tui.ts), and the /voice flow (src/voice-command.ts):
// set up or connect the hub when needed, share the session for Voice, open the browser on it with ?voice=1.
import { describe, expect, test } from "bun:test"
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
