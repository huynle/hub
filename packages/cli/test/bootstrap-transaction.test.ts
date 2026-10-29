// The transactional applier (packages/cli/src/bootstrap/transaction): apply a contract SetupPlan on a fake host
// under the apply lock, after preview revalidation and explicit consent, with the ownership journal, backups,
// atomic replacement and rollback that never overwrites user edits and never restores a stale credential.
// Crash injection at every step boundary lives in bootstrap-transaction-crash.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { BOOTSTRAP_EXIT, exitFor, findSecrets, validateJournal, type Action } from "../src/bootstrap/contracts/index.ts"
import { nodeFs } from "../src/bootstrap/transaction/fs.ts"
import { ACTIONS, MANUAL_EDIT_MERGE, MINUTE, OTHER_HOST } from "./bootstrap/fixtures.ts"
import { digestOfText, FaultyFs, HARNESS_FILES, HUBCTL_BYTES, NEW_TOKEN, NODE_JSON, OLD_CREDENTIAL, OPENCODE_JSON, pauseAt, SERVICE_UNIT, World, type WorldOptions } from "./bootstrap/transaction-fixtures.ts"

let worlds: World[] = []
const world = (options?: WorldOptions) => {
  const w = new World(options)
  worlds.push(w)
  return w
}
afterEach(() => {
  for (const w of worlds) w.cleanup()
  worlds = []
})

const ALL = { escalate: false, confirmActivation: true }
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

/** Leftover staging or temporary files anywhere in the sandbox. */
function leftovers(w: World): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`
      if (/\.hub-tx_|\.tmp$|\.broken-/.test(name)) found.push(p)
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(w.box.dir)
  return found
}

describe("apply", () => {
  test("applies a full plan: every step lands, the journal is committed and secret-free, the lock is released", async () => {
    const w = world({ oldCredential: true })
    const plan = w.plan()
    const r = await w.applier().apply({ token: w.token(plan), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("ok")
    if (!r.ok) return
    expect(r.report.state).toBe("committed")
    expect(statSync(w.box.path("state", "hub")).mode & 0o777).toBe(0o700)
    expect(w.read("user-bin", "hubctl")).toBe(HUBCTL_BYTES)
    expect(statSync(w.box.path("user-bin", "hubctl")).mode & 0o777).toBe(0o755)
    expect(readlinkSync(w.box.path("user-bin", "hub"))).toBe(w.box.path("user-bin", "hubctl"))
    expect(w.read("config", "hub/node.json")).toBe(NODE_JSON)
    expect(statSync(w.box.path("config", "hub/node.json")).mode & 0o777).toBe(0o600)
    const opencode = JSON.parse(w.read("config", "opencode/opencode.json"))
    expect(opencode).toEqual({ $schema: "https://opencode.ai/config.json", theme: "dark", "x-user-key": { keep: true }, plugins: ["@huynle/hub"] })
    for (const f of HARNESS_FILES) expect(w.read("data", `hub/harnesses/opencode/2.0.26/${f.rel}`)).toBe(f.text)
    expect(w.read("launch-agents", "io.github.huynle.hub-node.plist")).toBe(SERVICE_UNIT)
    expect(JSON.parse(w.read("config", "hub/config.json"))).toMatchObject({ token: NEW_TOKEN, theme: "kept" })
    expect(w.calls).toEqual(["verify opencode", "enroll dev-mac", "activate node", "launch opencode"])
    expect(existsSync(w.box.path("state", "hub/bootstrap/apply.lock"))).toBe(false)
    expect(existsSync(w.box.path("state", `hub/bootstrap/backups/${r.report.txID}`))).toBe(false)
    expect(leftovers(w)).toEqual([])
    const texts = w.journalTexts()
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) {
      expect(t).not.toContain(NEW_TOKEN)
      expect(t).not.toContain(OLD_CREDENTIAL.token)
      expect(findSecrets(JSON.parse(t))).toEqual([])
    }
    const journal = JSON.parse(texts.find((t) => t.includes('"hub.transaction-journal"'))!)
    expect(validateJournal(journal).ok).toBe(true)
    expect(journal.state).toBe("committed")
    const credential = journal.entries.find((e: { class: string }) => e.class === "credential")
    expect(credential.backup).toBeUndefined()
  })

  test("records the pinned digest as evidence for the harness install", async () => {
    const w = world()
    const plan = w.plan()
    const r = await w.applier().apply({ token: w.token(plan), replan: w.replan(), consent: ALL })
    expect(r.ok && r.report.evidence).toEqual([{ actionID: "install-opencode", results: [{ kind: "sha256-pin", status: "verified" }] }])
  })

  test("a retry of an applied plan changes nothing and journals every step as skipped", async () => {
    const w = world()
    const a = w.applier()
    const first = await a.apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(first)).toBe("ok")
    const after = w.snapshot()
    const plan = w.plan()
    const second = await a.apply({ token: w.token(plan), replan: w.replan(), consent: ALL })
    expect(codeOf(second)).toBe("ok")
    expect(w.snapshot()).toEqual(after)
    if (!second.ok) return
    const local = second.report.steps.filter((s) => !["verify-harness", "enroll-machine", "activate-service", "launch-session"].includes(s.kind))
    expect(local.every((s) => s.outcome === "skipped")).toBe(true)
  })

  test("a failed step rolls back, and the same plan applies cleanly once the cause is fixed", async () => {
    const w = world({ verifyFails: true })
    const before = w.snapshot()
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(exitFor("harness_not_ready")).toBe(BOOTSTRAP_EXIT.notReady)
    if (r.ok) return
    expect(r.report?.state).toBe("rolled-back")
    expect(w.snapshot()).toEqual(before)
    expect(leftovers(w)).toEqual([])
    w.verifyFails = false
    const again = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(again)).toBe("ok")
  })
})

describe("consent, host and version checks", () => {
  test("service activation needs explicit confirmation; nothing changes without it", async () => {
    const w = world()
    const before = w.snapshot({ includeBootstrapState: true })
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: {} })
    expect(codeOf(r)).toBe("needs_user")
    expect(w.snapshot({ includeBootstrapState: true })).toEqual(before)
    expect(existsSync(w.box.path("state", "hub"))).toBe(false)
  })

  test("an elevated action needs --escalate", async () => {
    const w = world()
    const elevated = { ...ACTIONS["install-artifact"], id: "hubctl-system", escalation: "elevated", path: { root: "system-bin", rel: "hubctl" }, sha256: digestOfText(HUBCTL_BYTES) } as Action
    const replan = w.replan((p) => ({ ...p, requiresEscalation: true, actions: [...p.actions, elevated] }))
    const plan = (await replan()).plan
    const r = await w.applier().apply({ token: w.token(plan), replan, consent: ALL })
    expect(codeOf(r)).toBe("escalation_required")
    const ok = await w.applier().apply({ token: w.token(plan), replan, consent: { ...ALL, escalate: true } })
    expect(codeOf(ok)).toBe("ok")
    expect(w.read("system-bin", "hubctl")).toBe(HUBCTL_BYTES)
  })

  test("a plan for another target is refused", async () => {
    const w = world()
    const r = await w.applier({ host: { fingerprint: w.plan().hostFingerprint, target: "linux-x64" } }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("wrong_platform")
  })

  test("a refused downgrade or a plan whose artifact the verified manifest does not pin changes nothing", async () => {
    const w = world()
    const before = w.snapshot()
    // v1.1: the unpinned version is installed into its own directory and made current.
    const unpinned = w.replan((p) => ({
      ...p,
      actions: p.actions.map((a) =>
        a.kind === "install-harness"
          ? { ...a, version: "2.0.27", path: { root: "data", rel: "hub/harnesses/opencode/2.0.27" } }
          : a.kind === "select-harness-version"
            ? { ...a, version: "2.0.27", target: { root: "data", rel: "hub/harnesses/opencode/2.0.27" } }
            : a,
      ),
    }))
    const r = await w.applier().apply({ token: w.token((await unpinned()).plan), replan: unpinned, consent: ALL })
    expect(codeOf(r)).toBe("unpinned_artifact")
    const wrongDigest = w.replan((p) => ({ ...p, actions: p.actions.map((a) => (a.kind === "install-artifact" ? { ...a, sha256: OTHER_HOST } : a)) }))
    const r2 = await w.applier().apply({ token: w.token((await wrongDigest()).plan), replan: wrongDigest, consent: ALL })
    expect(codeOf(r2)).toBe("integrity_mismatch")
    expect(w.snapshot()).toEqual(before)
  })

  test("an invalid plan (a traversal smuggled past the planner) is refused before anything runs", async () => {
    const w = world()
    const evil = w.replan((p) => ({ ...p, actions: p.actions.map((a) => (a.kind === "write-file" ? { ...a, path: { root: "config", rel: "../../.ssh/authorized_keys" } } : a)) }))
    const r = await w.applier().apply({ token: w.token((await evil()).plan), replan: evil, consent: ALL })
    expect(codeOf(r)).toBe("invalid")
    expect(existsSync(`${w.box.dir}/home/.ssh`)).toBe(false)
  })
})

/** Every entry under the sandbox, directories included (the applier's own state too): proof a call wrote nothing. */
function entries(w: World): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = `${dir}/${name}`
      out.push(p.slice(w.box.dir.length + 1))
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(w.box.dir)
  return out
}

describe("preview revalidation", () => {
  test("a stale preview (the host changed since) applies nothing", async () => {
    const w = world()
    const token = w.token(w.plan())
    writeFileSync(w.box.path("config", "opencode/opencode.json"), '{"theme":"light"}\n')
    const before = w.snapshot()
    const r = await w.applier().apply({ token, replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("preview_stale")
    expect(exitFor("preview_stale")).toBe(BOOTSTRAP_EXIT.previewInvalid)
    expect(w.snapshot()).toEqual(before)
  })

  test("expired, foreign and replayed previews are refused", async () => {
    const w = world()
    const plan = w.plan()
    const expired = await w.applier().apply({ token: w.token(plan, { issuedAt: w.now - 11 * MINUTE, expiresAt: w.now - MINUTE }), replan: w.replan(), consent: ALL })
    expect(codeOf(expired)).toBe("preview_expired")
    const foreign = await w.applier().apply({ token: w.token(plan, { hostFingerprint: OTHER_HOST }), replan: w.replan(), consent: ALL })
    expect(codeOf(foreign)).toBe("preview_foreign")
    const token = w.token(plan)
    expect(codeOf(await w.applier().apply({ token, replan: w.replan(), consent: ALL }))).toBe("ok")
    const replay = await w.applier().apply({ token, replan: w.replan(), consent: ALL })
    expect(codeOf(replay)).toBe("preview_replayed")
  })

  test("a refused apply on a fresh host creates nothing, not even the applier's own state directories", async () => {
    const cases: [string, (w: World) => Parameters<ReturnType<World["applier"]>["apply"]>[0]][] = [
      ["preview_expired", (w) => ({ token: w.token(w.plan(), { issuedAt: w.now - 11 * MINUTE, expiresAt: w.now - MINUTE }), replan: w.replan(), consent: ALL })],
      ["preview_foreign", (w) => ({ token: w.token(w.plan(), { hostFingerprint: OTHER_HOST }), replan: w.replan(), consent: ALL })],
      ["preview_stale", (w) => ({ token: w.token(w.plan({ omit: ["first-launch"] })), replan: w.replan(), consent: ALL })],
      ["invalid", (w) => ({ token: w.token(w.plan()), replan: w.replan((p) => ({ ...p, version: 99 }) as never), consent: ALL })],
      ["manual_edit_required", (w) => ({ token: w.token(w.plan()), replan: w.replan(undefined, { blockers: [MANUAL_EDIT_MERGE] }), consent: ALL })],
      ["needs_user", (w) => ({ token: w.token(w.plan()), replan: w.replan(), consent: {} })],
    ]
    for (const [code, request] of cases) {
      const w = world()
      const before = entries(w)
      expect([code, codeOf(await w.applier().apply(request(w)))]).toEqual([code, code])
      expect([code, entries(w)]).toEqual([code, before])
    }
  })

  test("a manual-edit blocker or failed evidence in the fresh plan blocks apply", async () => {
    const w = world()
    const plan = w.plan()
    const blocked = await w.applier().apply({ token: w.token(plan), replan: w.replan(undefined, { blockers: [MANUAL_EDIT_MERGE] }), consent: ALL })
    expect(codeOf(blocked)).toBe("manual_edit_required")
    const failed = await w
      .applier()
      .apply({ token: w.token(plan), replan: w.replan(undefined, { evidence: [{ actionID: "install-opencode", kind: "sigstore", status: "failed" }] }), consent: ALL })
    expect(codeOf(failed)).toBe("evidence_failed")
  })
})

describe("concurrency and the lock", () => {
  test("a second apply while one runs is refused with locked; the first completes", async () => {
    const w = world()
    const pause = pauseAt("node-json")
    const first = w.applier({ hooks: pause.hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    await pause.reached
    const second = await w.applier({ pid: 5151 }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(second)).toBe("locked")
    expect(exitFor("locked")).toBe(BOOTSTRAP_EXIT.locked)
    const recover = await w.applier({ pid: 5151 }).recover({ mode: "rollback" })
    expect(codeOf(recover)).toBe("locked")
    pause.resume()
    expect(codeOf(await first)).toBe("ok")
  })

  test("another host's lock is never broken", async () => {
    const w = world()
    const pause = pauseAt("node-json")
    const first = w.applier({ hooks: pause.hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    await pause.reached
    const other = await w.applier({ host: { fingerprint: OTHER_HOST, target: "darwin-arm64" }, isAlive: () => false }).recover({ mode: "rollback" })
    expect(codeOf(other)).toBe("locked")
    pause.resume()
    expect(codeOf(await first)).toBe("ok")
  })
})

describe("artifacts", () => {
  test("tampered hubctl bytes are rejected before use and everything rolls back", async () => {
    const w = world({ tamperedHubctl: true })
    const before = w.snapshot()
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("integrity_mismatch")
    expect(exitFor("integrity_mismatch")).toBe(BOOTSTRAP_EXIT.artifactRejected)
    expect(w.snapshot()).toEqual(before)
  })

  test("a tampered harness archive or failed upstream evidence is rejected and rolled back", async () => {
    for (const [options, code] of [
      [{ tamperedHarness: true }, "integrity_mismatch"],
      [{ failedEvidence: true }, "inconsistent-evidence"],
    ] as const) {
      const w = world(options)
      const before = w.snapshot()
      const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
      // OpenCode's pin lists no upstream evidence: a sigstore result nobody planned is refused (invalid).
      expect(codeOf(r)).toBe(code === "inconsistent-evidence" ? "invalid" : code)
      expect(w.snapshot()).toEqual(before)
      expect(existsSync(w.box.path("data", "hub/harnesses/opencode/2.0.26"))).toBe(false)
    }
  })
})

describe("symlinks", () => {
  test("a config behind a symlink is refused: nothing is written into the linked repository", async () => {
    const w = world()
    const dot = `${w.box.dir}/dotfiles/opencode`
    mkdirSync(dot, { recursive: true })
    renameSync(w.box.path("config", "opencode/opencode.json"), `${dot}/opencode.json`)
    rmSync(w.box.path("config", "opencode"), { recursive: true })
    symlinkSync(dot, w.box.path("config", "opencode"))
    const before = w.snapshot()
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("conflict")
    expect(exitFor("conflict")).toBe(BOOTSTRAP_EXIT.conflict)
    expect(w.snapshot()).toEqual(before)
    expect(readFileSync(`${dot}/opencode.json`, "utf8")).toBe(OPENCODE_JSON)
  })

  test("a symlink planted between steps is refused at its step and the transaction rolls back", async () => {
    const w = world()
    const before = w.snapshot()
    const dot = `${w.box.dir}/dotfiles`
    mkdirSync(dot)
    let planted = false
    const hooks = {
      afterAction: (entry: { actionID: string }) => {
        if (entry.actionID !== "node-json" || planted) return
        planted = true
        // An attacker swaps the hub config directory for a link to somewhere else.
        renameSync(w.box.path("config", "hub"), `${w.box.dir}/moved-hub`)
        symlinkSync(dot, w.box.path("config", "hub"))
      },
    }
    const plan = w.plan()
    const r = await w.applier({ hooks }).apply({ token: w.token(plan), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("conflict")
    expect(readdirSync(dot)).toEqual([])
    // Everything outside the attacked directory is back as it was.
    const now = w.snapshot()
    for (const [k, v] of Object.entries(before)) expect(now[k]).toBe(v)
  })
})

describe("disk failure", () => {
  test("ENOSPC at any write rolls back to the starting state and leaves no staging files", async () => {
    // Count the mutations of a successful run first.
    const probe = world()
    const counted = new FaultyFs(nodeFs)
    expect(codeOf(await probe.applier({ fs: counted }).apply({ token: probe.token(probe.plan()), replan: probe.replan(), consent: ALL }))).toBe("ok")
    const writes = counted.log.filter((l) => l.startsWith("writeExclusive")).length
    expect(writes).toBeGreaterThan(10)
    for (let n = 1; n <= counted.mutations; n++) {
      const w = world()
      const before = w.snapshot()
      const fs = new FaultyFs(nodeFs, { enospcAt: n, enospcOn: ["writeExclusive", "mkdir", "rename", "link", "symlink"] })
      const r = await w.applier({ fs }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
      if (r.ok) continue // the failing op was best-effort (e.g. cleanup) or not a counted kind
      expect(["internal", "locked", "recovery_required"]).toContain(r.code)
      if (r.code === "recovery_required") {
        expect(codeOf(await w.applier().recover({ mode: "rollback" }))).toBe("ok")
      }
      // A credential this transaction stored is cleared (CredentialStore.clear keeps the rest of the file), never restored.
      const outside = (snap: Record<string, string>) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith("home/.config/hub")))
      expect({ n, snap: outside(w.snapshot()) }).toEqual({ n, snap: outside(before) })
      if (existsSync(w.box.path("config", "hub/config.json"))) expect(w.read("config", "hub/config.json")).not.toContain(NEW_TOKEN)
      expect({ n, left: leftovers(w) }).toEqual({ n, left: [] })
      w.cleanup()
      worlds = worlds.filter((x) => x !== w)
    }
  }, 120_000)
})

describe("rollback", () => {
  test("an intervening user edit is kept (reported as a conflict, never overwritten); the rest rolls back", async () => {
    const w = world({ verifyFails: true })
    const userEdit = '{"theme":"user edited during apply"}\n'
    const hooks = {
      beforeAction: (entry: { actionID: string }) => {
        if (entry.actionID === "verify-opencode") writeFileSync(w.box.path("config", "opencode/opencode.json"), userEdit)
      },
    }
    const r = await w.applier({ hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("harness_not_ready")
    if (r.ok) return
    expect(w.read("config", "opencode/opencode.json")).toBe(userEdit)
    expect(r.report?.conflicts.map((c) => c.actionID)).toEqual(["opencode-plugin"])
    expect(existsSync(w.box.path("config", "hub/node.json"))).toBe(false)
    expect(existsSync(w.box.path("user-bin", "hubctl"))).toBe(false)
  })

  test("a stale credential is never restored: the new one is cleared, the old one does not come back", async () => {
    const w = world({ oldCredential: true })
    const hooks = {
      afterAction: (entry: { actionID: string }) => {
        if (entry.actionID === "enroll") w.verifyFails = true
      },
    }
    // Fail after enrollment: verify runs before enroll in this plan, so fail at activation instead.
    const replan = w.replan((p) => ({ ...p, actions: [...p.actions.filter((a) => a.kind !== "verify-harness" && a.kind !== "launch-session" && a.kind !== "install-harness" && a.kind !== "select-harness-version"), { ...ACTIONS["verify-harness"], id: "verify-late" } as Action] }))
    const r = await w.applier({ hooks }).apply({ token: w.token((await replan()).plan), replan, consent: ALL })
    expect(codeOf(r)).toBe("harness_not_ready")
    const config = JSON.parse(w.read("config", "hub/config.json"))
    expect(config.token).toBeUndefined()
    expect(config.machineID).toBeUndefined()
    expect(config.theme).toBe("kept")
    expect(JSON.stringify(config)).not.toContain(OLD_CREDENTIAL.token)
    expect(w.calls).toContain("clear-credential")
    expect(w.calls).toContain("deactivate node")
  })

  test("a tampered backup is never restored", async () => {
    const w = world({ verifyFails: true })
    const hooks = {
      beforeAction: (entry: { actionID: string }) => {
        if (entry.actionID !== "verify-opencode") return
        const dir = w.box.path("state", "hub/bootstrap/backups")
        for (const tx of readdirSync(dir)) for (const bk of readdirSync(`${dir}/${tx}`)) writeFileSync(`${dir}/${tx}/${bk}`, '{"evil":true}')
      },
    }
    const r = await w.applier({ hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("harness_not_ready")
    if (r.ok) return
    expect(w.read("config", "opencode/opencode.json")).not.toContain("evil")
    expect(r.report?.conflicts.map((c) => c.actionID)).toContain("opencode-plugin")
  })

  test("recover with nothing interrupted is a no-op", async () => {
    const w = world()
    expect(codeOf(await w.applier().recover({ mode: "rollback" }))).toBe("ok")
  })
})
