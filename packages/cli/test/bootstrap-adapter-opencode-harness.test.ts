// HBS-06: the assembled OpenCode harness (index.ts): presence from read-only discovery (never health), verification
// of the binary that really runs (hub's current version, expected to report exactly that version), and the pieces
// the integrator merges into the applier.
import { describe, expect, test } from "bun:test"
import { createAdapterRegistry, isHarnessReady, type AdapterContext } from "../src/bootstrap/contracts/index.ts"
import { createOpencodeHarness, type ProcessRequest } from "../src/bootstrap/adapters/opencode/index.ts"
import { MAC_HOME, MAC_NATIVE, MAC_NO_HARNESS, exe, link, memoryProbe, MACHO, type HostSpec } from "./bootstrap/discovery-fixtures.ts"
import { T0 } from "./bootstrap/fixtures.ts"
import { signedManifest } from "./bootstrap/opencode-adapter-fixtures.ts"

const context: AdapterContext = { env: { HOME: MAC_HOME }, home: MAC_HOME, platform: "darwin", arch: "arm64", now: () => T0 }
const runner = (version: string) => {
  const calls: ProcessRequest[] = []
  return {
    calls,
    run: async (r: ProcessRequest) => (calls.push(r), r.argv[0] === "--version" ? { exitCode: 0, stdout: `opencode v${version}\n`, timedOut: false } : { exitCode: 0, stdout: "anthropic/claude-x\n", timedOut: false }),
  }
}
const spoke = { connected: async () => ({ ok: true }) }

const HUB_MANAGED: HostSpec = {
  ...MAC_NO_HARNESS,
  files: {
    ...MAC_NO_HARNESS.files,
    [`${MAC_HOME}/.local/share/hub/harnesses/opencode/2.2.0/bin/opencode`]: exe(MACHO),
    [`${MAC_HOME}/.local/share/hub/harnesses/opencode/current`]: link("2.2.0"),
  },
}

describe("createOpencodeHarness", () => {
  test("discover reports presence only (health stays unverified)", async () => {
    const h = createOpencodeHarness({ probe: memoryProbe(MAC_NATIVE), runner: runner("2.2.0") })
    expect(await h.adapter.discover(context)).toMatchObject({ id: "opencode", installed: true, path: `${MAC_HOME}/.opencode/bin/opencode`, health: { state: "unverified", probes: [] } })
    expect(await createOpencodeHarness({ probe: memoryProbe(MAC_NO_HARNESS) }).adapter.discover(context)).toMatchObject({ installed: false })
  })

  test("verify probes hub's current binary and expects exactly its version", async () => {
    const r = runner("2.2.0")
    const h = createOpencodeHarness({ probe: memoryProbe(HUB_MANAGED), runner: r, spoke })
    const v = await h.adapter.verify(context)
    expect(r.calls[0]!.file).toBe(`${MAC_HOME}/.local/share/hub/harnesses/opencode/2.2.0/bin/opencode`)
    expect(isHarnessReady(v, T0)).toBe(true)
    const wrong = await createOpencodeHarness({ probe: memoryProbe(HUB_MANAGED), runner: runner("2.1.0"), spoke }).adapter.verify(context)
    expect(isHarnessReady(wrong, T0)).toBe(false)
  })

  test("without a spoke probe it is never ready, even when the binary and provider answer", async () => {
    const v = await createOpencodeHarness({ probe: memoryProbe(MAC_NATIVE), runner: runner("2.2.0") }).adapter.verify(context)
    expect(v.probes.find((p) => p.kind === "spoke-connected")).toMatchObject({ ok: false })
    expect(isHarnessReady(v, T0)).toBe(false)
  })

  test("source only with a manifest; executors for the two adapter kinds; registers once", () => {
    expect(createOpencodeHarness({ probe: memoryProbe(MAC_NATIVE) }).source).toBeUndefined()
    const h = createOpencodeHarness({ probe: memoryProbe(MAC_NATIVE), manifest: signedManifest(), download: async () => new Uint8Array() })
    expect(h.source).toBeDefined()
    expect(Object.keys(h.executors(() => context)).sort()).toEqual(["register-mcp-server", "verify-harness"])
    const registry = createAdapterRegistry()
    registry.register(h.adapter)
    expect(() => registry.register(h.adapter)).toThrow(/already registered/)
  })
})
