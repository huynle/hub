// The node-services adapter renders the hub node and harness spoke service units from the embedded templates
// (EMBEDDED_ASSETS) with the standalone argv contract (serviceArgv word lists): golden units for systemd --user and
// launchd, idempotent re-rendering, no leftover template placeholders, and no secrets in a unit.
import { describe, expect, test } from "bun:test"
import { EMBEDDED_ASSETS, SERVICE_IDS, sha256Hex, type ServiceManagerID } from "../src/bootstrap/contracts/index.ts"
import { renderServiceUnit, SERVICE_ENVIRONMENT } from "../src/bootstrap/adapters/node-services/render.ts"
import {
  GOLDEN_LAUNCHD_CODEX,
  GOLDEN_LAUNCHD_NODE,
  GOLDEN_SYSTEMD_CLAUDE_SCRIPT,
  GOLDEN_SYSTEMD_NODE,
  SCRIPT_LINUX,
  STANDALONE_DARWIN,
  STANDALONE_LINUX,
} from "./bootstrap/node-services-fixtures.ts"

const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly { code: string }[] }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.issues)}`)
  return r.value
}
const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))

describe("golden units", () => {
  test("systemd --user: hub node from a standalone hubctl", () => {
    const unit = value(renderServiceUnit({ service: "node", manager: "systemd-user", layout: STANDALONE_LINUX, home: "/home/dev" }))
    expect(unit.text).toBe(GOLDEN_SYSTEMD_NODE)
    expect(unit.asset).toBe("service/systemd-user/node")
    expect(unit.path).toEqual({ root: "systemd-user", rel: "hub-node.service" })
    expect(unit.name).toBe("hub-node.service")
    expect(unit.sha256).toBe(`sha256:${sha256Hex(GOLDEN_SYSTEMD_NODE)}`)
    expect(new TextDecoder().decode(unit.bytes)).toBe(GOLDEN_SYSTEMD_NODE)
  })

  test("systemd --user: the Claude Code spoke from a script layout, with quoting, % escaping and carried settings", () => {
    const unit = value(
      renderServiceUnit({
        service: "claude-code",
        manager: "systemd-user",
        layout: SCRIPT_LINUX,
        home: "/home/dev",
        environment: { XDG_CONFIG_HOME: "/home/dev/.config", HUB_CLAUDE_BIN: "/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude" },
      }),
    )
    expect(unit.text).toBe(GOLDEN_SYSTEMD_CLAUDE_SCRIPT)
  })

  test("launchd: hub node from a standalone hubctl, one <string> per argv word", () => {
    const unit = value(renderServiceUnit({ service: "node", manager: "launchd", layout: STANDALONE_DARWIN, home: "/Users/dev" }))
    expect(unit.text).toBe(GOLDEN_LAUNCHD_NODE)
    expect(unit.path).toEqual({ root: "launch-agents", rel: "io.github.huynle.hub-node.plist" })
    expect(unit.name).toBe("io.github.huynle.hub-node")
  })

  test("launchd: the Codex spoke with its harness binary carried in", () => {
    const unit = value(
      renderServiceUnit({ service: "codex-spoke", manager: "launchd", layout: STANDALONE_DARWIN, home: "/Users/dev", environment: { HUB_CODEX_BIN: "/Users/dev/.local/share/hub/harnesses/codex/current/bin/codex" } }),
    )
    expect(unit.text).toBe(GOLDEN_LAUNCHD_CODEX)
  })

  test("launchd escapes XML in argv words and settings", () => {
    const unit = value(renderServiceUnit({ service: "node", manager: "launchd", layout: { kind: "standalone", executable: "/Users/a&b/<hub>" }, home: "/Users/a&b" }))
    expect(unit.text).toContain("<string>/Users/a&amp;b/&lt;hub&gt;</string>")
    expect(unit.text).toContain("<string>/Users/a&amp;b/.local/state/hub/node.log</string>")
  })
})

describe("every embedded template renders", () => {
  const cases = SERVICE_IDS.flatMap((service) => (["launchd", "systemd-user"] as ServiceManagerID[]).map((manager) => ({ service, manager })))
  for (const { service, manager } of cases)
    test(`${service} on ${manager}: no placeholders, the asset's file name, idempotent`, () => {
      const input = { service, manager, layout: manager === "launchd" ? STANDALONE_DARWIN : STANDALONE_LINUX, home: manager === "launchd" ? "/Users/dev" : "/home/dev" }
      const first = value(renderServiceUnit(input))
      const again = value(renderServiceUnit(input))
      expect(again.text).toBe(first.text)
      expect(again.sha256).toBe(first.sha256)
      expect(first.text).not.toMatch(/__[A-Z]+__/)
      expect(first.text).not.toContain("sed ")
      expect(first.path.rel).toBe(EMBEDDED_ASSETS[first.asset]!.installAs)
    })
})

describe("refusals", () => {
  test("a relative or multi-line program path is refused (never a shell string)", () => {
    expect(codes(renderServiceUnit({ service: "node", manager: "systemd-user", layout: { kind: "standalone", executable: "hubctl" }, home: "/home/dev" }))).toEqual(["invalid_path"])
    expect(codes(renderServiceUnit({ service: "node", manager: "systemd-user", layout: { kind: "standalone", executable: "/bin/x\nExecStartPre=/bin/evil" }, home: "/home/dev" }))).toEqual(["invalid_path"])
  })

  test("a broad or unsafe home is refused", () => {
    for (const home of ["/", "relative", "/home/dev\nX=1", "/home/../etc"])
      expect(codes(renderServiceUnit({ service: "node", manager: "systemd-user", layout: STANDALONE_LINUX, home }))).toContain("invalid_path")
  })

  test("only the service's carried settings, single-line, never a credential", () => {
    const render = (environment: Record<string, string>) => renderServiceUnit({ service: "node", manager: "systemd-user", layout: STANDALONE_LINUX, home: "/home/dev", environment })
    expect(codes(render({ LD_PRELOAD: "/tmp/evil.so" }))).toEqual(["invalid_value"])
    expect(codes(render({ HUB_SPOKE_CONFIG: "/a\nExecStartPre=/bin/evil" }))).toEqual(["invalid_value"])
    expect(codes(render({ HUB_SPOKE_CONFIG: "mt_abcdefgh12345678" }))).toEqual(["secret"])
    expect(SERVICE_ENVIRONMENT.node).not.toContain("HUB_TOKEN")
  })
})
