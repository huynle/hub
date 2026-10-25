// A child process's stdio as a channel of lines: `codex app-server --listen stdio://` reads one JSON message per
// line on stdin and writes one per line on stdout. Its stderr goes to a log callback; its exit closes the channel;
// closing the channel ends the child.
import { describe, expect, test } from "bun:test"
import { spawnStdioChannel } from "../src/stdio.ts"

const ECHO = `process.stdin.setEncoding("utf8");let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l==="exit")process.exit(3);process.stderr.write("seen "+l+"\\n");process.stdout.write(l.toUpperCase()+"\\n")}})`

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("spawnStdioChannel", () => {
  test("sends and receives lines; stderr reaches the log", async () => {
    const logs: string[] = []
    const child = spawnStdioChannel({ command: process.execPath, args: ["-e", ECHO], env: { PATH: process.env.PATH ?? "" }, log: (l) => logs.push(l) })
    const got: string[] = []
    child.channel.onMessage((t) => got.push(t))
    child.channel.send('{"a":1}')
    child.channel.send("two")
    await until(() => got.length === 2)
    expect(got).toEqual(['{"A":1}', "TWO"])
    await until(() => logs.some((l) => l.includes("seen two")))
    expect(child.pid).toBeGreaterThan(0)
    child.channel.close()
    await child.exited
  })

  test("the child exiting closes the channel with its exit code", async () => {
    const child = spawnStdioChannel({ command: process.execPath, args: ["-e", ECHO], env: { PATH: process.env.PATH ?? "" } })
    const reasons: string[] = []
    child.channel.onClose((r) => reasons.push(r))
    child.channel.send("exit")
    await until(() => reasons.length === 1)
    expect(reasons[0]).toMatch(/exited.*3/)
  })

  test("closing the channel ends the child", async () => {
    const child = spawnStdioChannel({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } })
    const reasons: string[] = []
    child.channel.onClose((r) => reasons.push(r))
    child.channel.close()
    const exit = await child.exited
    expect(exit.code !== 0 || exit.signal !== null).toBe(true)
    expect(reasons).toHaveLength(1)
  })

  test("a command that cannot run closes the channel with the reason", async () => {
    const child = spawnStdioChannel({ command: "/nonexistent/codex-binary", args: [], env: {} })
    const reasons: string[] = []
    child.channel.onClose((r) => reasons.push(r))
    await until(() => reasons.length === 1)
    expect(reasons[0]).toMatch(/ENOENT|cannot run|not found/i)
  })
})
