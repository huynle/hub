// The Hub TUI command registry (src/tui-commands.ts): one entry per /<feature>, namespaced and grouped as Hub.
import { describe, expect, test } from "bun:test"
import { COMMAND_GROUP, hubCommands, type HubCommand } from "../src/tui-commands"

const feature = (id: string, slash = id, run: () => Promise<unknown> = async () => {}): HubCommand => ({ id, slash, title: `${id} title`, run })

describe("hubCommands", () => {
  test("namespaces IDs, prefixes titles and groups everything under Hub", () => {
    const [cmd] = hubCommands([feature("voice")], () => {})
    expect(COMMAND_GROUP).toBe("Hub")
    expect(cmd).toMatchObject({ id: "hub.voice", title: "Hub: voice title", group: "Hub", palette: true, slash: { name: "voice" } })
  })

  test("keeps the order of the features", () => {
    expect(hubCommands([feature("open", "hub"), feature("voice")], () => {}).map((c) => c.slash.name)).toEqual(["hub", "voice"])
  })

  test("refuses duplicate IDs and slash names", () => {
    expect(() => hubCommands([feature("a", "x"), feature("a", "y")], () => {})).toThrow(/duplicate.*id/)
    expect(() => hubCommands([feature("a", "x"), feature("b", "x")], () => {})).toThrow(/duplicate.*\/x/)
  })

  test("a failing run goes to onError instead of throwing", async () => {
    const errors: unknown[] = []
    const [cmd] = hubCommands([feature("boom", "boom", async () => Promise.reject(new Error("nope")))], (e) => errors.push(e))
    expect(() => cmd!.run()).not.toThrow()
    await Bun.sleep(0)
    expect((errors[0] as Error).message).toBe("nope")
  })

  test("a command with arguments gets the raw text after its name; others keep the plain slash", () => {
    const seen: Array<string | undefined> = []
    const [plain, withArgs] = hubCommands(
      [feature("voice"), { id: "msg", slash: "msg", title: "msg title", arguments: true, run: async (input) => void seen.push(input) }],
      () => {},
    )
    expect(plain!.slash).toEqual({ name: "voice" })
    expect(withArgs!.slash).toEqual({ name: "msg", arguments: true })
    withArgs!.run('@bob  hello "there"')
    withArgs!.run("")
    withArgs!.run(undefined)
    expect(seen).toEqual(['@bob  hello "there"', "", undefined])
  })

  test("a key event or other non-string input reaches run as no arguments", () => {
    const seen: unknown[] = []
    const [cmd] = hubCommands([{ id: "who", slash: "who", title: "who", arguments: true, run: async (input) => void seen.push(input) }], () => {})
    ;(cmd!.run as (input?: unknown) => void)({ name: "return" })
    expect(seen).toEqual([undefined])
  })
})
