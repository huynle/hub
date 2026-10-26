// The tmux backend: exact tmux argv against a fake runner (no tmux needed), and the user's own tmux server never
// touched unless explicitly asked (the "current" target, which needs $TMUX).
import { describe, expect, test } from "bun:test"
import { tmuxArg, tmuxBackend, type TmuxRunner } from "../src/tmux.ts"

function fakeTmux(answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[][] = []
  const run: TmuxRunner = async (args) => {
    calls.push(args)
    const verb = args.find((a) => !a.startsWith("-") && !["hub-x", "/dev/null"].includes(a)) ?? ""
    const answer = answers[verb] ?? {}
    return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
  }
  return { run, calls }
}

const PANE = { session: "hub-cat-1", window: "@1", target: "%1" }

describe("tmux backend on a private socket", () => {
  test("launch: a detached new session on -L <socket>, the argv after --, never through a shell", async () => {
    const tmux = fakeTmux({ "new-session": { stdout: "hub-cat-1\t@1\t%1\n" } })
    const backend = tmuxBackend({ socket: "hub-x", config: "/dev/null", run: tmux.run })
    const pane = await backend.launch({ argv: ["goose", "session", "--name", "a b"], cwd: "/work", name: "hub-cat-1", env: { HUB_PRESET: "goose" } })
    expect(pane).toEqual(PANE)
    expect(tmux.calls).toEqual([
      ["-L", "hub-x", "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{session_name}\t#{window_id}\t#{pane_id}", "-s", "hub-cat-1", "-c", "/work", "-x", "200", "-y", "50", "-e", "HUB_PRESET=goose", "--", "goose", "session", "--name", "a b"],
    ])
  })

  test("a one-element argv is run by tmux through the shell, so only a plain program name is accepted alone", async () => {
    const tmux = fakeTmux({ "new-session": { stdout: "s\t@1\t%1\n" } })
    const backend = tmuxBackend({ socket: "hub-x", run: tmux.run })
    await backend.launch({ argv: ["cat"], cwd: "/", name: "s" })
    await expect(backend.launch({ argv: ["c*t"], cwd: "/", name: "s" })).rejects.toThrow(/plain program name/)
    expect(tmux.calls.length).toBe(1)
  })

  test("launch fails with tmux's message", async () => {
    const tmux = fakeTmux({ "new-session": { code: 1, stderr: "duplicate session: s" } })
    await expect(tmuxBackend({ socket: "hub-x", run: tmux.run }).launch({ argv: ["cat"], cwd: "/", name: "s" })).rejects.toThrow(/duplicate session/)
  })

  test("paste: the text into a buffer, pasted (bracketed when the app asks), then Enter when submitting", async () => {
    const tmux = fakeTmux()
    const backend = tmuxBackend({ socket: "hub-x", run: tmux.run })
    await backend.paste(PANE, "-- line one\nline two", { submit: true })
    expect(tmux.calls[0]!.slice(0, 5)).toEqual(["-L", "hub-x", "set-buffer", "-b", tmux.calls[0]![4]!])
    expect(tmux.calls[0]!.slice(5)).toEqual(["--", "-- line one\nline two"])
    const buffer = tmux.calls[0]![4]!
    expect(buffer).toMatch(/^hub-preset-/)
    expect(tmux.calls.slice(1)).toEqual([
      ["-L", "hub-x", "paste-buffer", "-d", "-p", "-b", buffer, "-t", "%1"],
      ["-L", "hub-x", "send-keys", "-t", "%1", "Enter"],
    ])
    tmux.calls.length = 0
    await backend.paste(PANE, "x", { submit: false })
    expect(tmux.calls.map((c) => c[2])).toEqual(["set-buffer", "paste-buffer"])
  })

  test("interrupt sends Ctrl-C; it can send keys", async () => {
    const tmux = fakeTmux()
    const backend = tmuxBackend({ socket: "hub-x", run: tmux.run })
    expect(backend.canSendKeys).toBe(true)
    await backend.interrupt(PANE)
    expect(tmux.calls).toEqual([["-L", "hub-x", "send-keys", "-t", "%1", "C-c"]])
  })

  test("capture: the pane's recent lines, joined", async () => {
    const tmux = fakeTmux({ "capture-pane": { stdout: "hello\n" } })
    expect(await tmuxBackend({ socket: "hub-x", run: tmux.run }).capture(PANE, 100)).toBe("hello\n")
    expect(tmux.calls).toEqual([["-L", "hub-x", "capture-pane", "-p", "-J", "-t", "%1", "-S", "-100"]])
  })

  test("alive: the pane exists and is not dead", async () => {
    const live = fakeTmux({ "display-message": { stdout: "0\n" } })
    expect(await tmuxBackend({ socket: "hub-x", run: live.run }).alive(PANE)).toBe(true)
    expect(live.calls).toEqual([["-L", "hub-x", "display-message", "-p", "-t", "%1", "#{pane_dead}"]])
    expect(await tmuxBackend({ socket: "hub-x", run: fakeTmux({ "display-message": { stdout: "1\n" } }).run }).alive(PANE)).toBe(false)
    expect(await tmuxBackend({ socket: "hub-x", run: fakeTmux({ "display-message": { code: 1, stderr: "no server running" } }).run }).alive(PANE)).toBe(false)
  })

  test("kill ends the pane", async () => {
    const tmux = fakeTmux()
    await tmuxBackend({ socket: "hub-x", run: tmux.run }).kill(PANE)
    expect(tmux.calls).toEqual([["-L", "hub-x", "kill-pane", "-t", "%1"]])
  })

  test("describe: how to look at it", () => {
    expect(tmuxBackend({ socket: "hub-x", run: fakeTmux().run }).attachHint(PANE)).toBe("tmux -L hub-x attach -t hub-cat-1")
  })

  test("arguments ending in ; are escaped so tmux does not split its command line there", async () => {
    expect([";", "a;", "a\\;", "a;b", "x"].map(tmuxArg)).toEqual(["\\;", "a\\;", "a\\\\;", "a;b", "x"])
    const tmux = fakeTmux({ "new-session": { stdout: "s\t@1\t%1\n" } })
    await tmuxBackend({ socket: "hub-x", run: tmux.run }).launch({ argv: ["echo", "a", ";", "b"], cwd: "/", name: "s" })
    expect(tmux.calls[0]!.slice(-4)).toEqual(["echo", "a", "\\;", "b"])
  })

  test("refuses a socket name that is not a plain token", () => {
    expect(() => tmuxBackend({ socket: "../x", run: fakeTmux().run })).toThrow(/socket/)
  })
})

describe("tmux backend in the user's current session (explicit)", () => {
  test("needs $TMUX; refuses otherwise", () => {
    expect(() => tmuxBackend({ current: true, env: {}, run: fakeTmux().run })).toThrow(/TMUX/)
  })

  test("launch: a new window in the current session (no -L), detached", async () => {
    const tmux = fakeTmux({ "new-window": { stdout: "work\t@7\t%9\n" } })
    const backend = tmuxBackend({ current: true, env: { TMUX: "/tmp/tmux-501/default,1,0" }, run: tmux.run })
    expect(await backend.launch({ argv: ["aider", "--yes"], cwd: "/w", name: "aider" })).toEqual({ session: "work", window: "@7", target: "%9" })
    expect(tmux.calls).toEqual([["new-window", "-d", "-P", "-F", "#{session_name}\t#{window_id}\t#{pane_id}", "-n", "aider", "-c", "/w", "--", "aider", "--yes"]])
    expect(backend.attachHint({ session: "work", window: "@7", target: "%9" })).toBe("tmux select-window -t @7")
  })
})
