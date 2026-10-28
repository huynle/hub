// The transaction layer's filesystem foundations: file states (digest and mode only, never contents), PathRef
// resolution that refuses symlinks and traversal, and the O_EXCL apply lock with stale and foreign detection.
// Everything runs in a temporary sandbox (./bootstrap/transaction-fixtures.ts).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { LOCK_MAX_MS, sha256Hex, validateApplyLock, type ApplyLock } from "../src/bootstrap/contracts/index.ts"
import { nodeFs } from "../src/bootstrap/transaction/fs.ts"
import { breakStaleLock, releaseLock, renewLock, tryAcquireLock, type LockIO } from "../src/bootstrap/transaction/lock.ts"
import { resolveTarget } from "../src/bootstrap/transaction/resolve.ts"
import { fileState } from "../src/bootstrap/transaction/state.ts"
import { HOST, OTHER_HOST, T0 } from "./bootstrap/fixtures.ts"
import { sandbox, type Sandbox } from "./bootstrap/transaction-fixtures.ts"

let box: Sandbox
afterEach(() => box?.cleanup())

describe("fileState", () => {
  test("missing, file, symlink and directory states", () => {
    box = sandbox()
    const f = box.path("config", "a.json")
    expect(fileState(nodeFs, f)).toEqual({ exists: false })
    writeFileSync(f, "{}", { mode: 0o640 })
    expect(fileState(nodeFs, f)).toEqual({ exists: true, sha256: `sha256:${sha256Hex("{}")}`, mode: 0o640 })
    const l = box.path("config", "link")
    symlinkSync("/somewhere/else", l)
    expect(fileState(nodeFs, l)).toEqual({ exists: true, symlink: true, sha256: `sha256:${sha256Hex("/somewhere/else")}` })
    const d = box.path("config", "dir")
    mkdirSync(d, { mode: 0o700 })
    expect(fileState(nodeFs, d)).toEqual({ exists: true, mode: 0o700 })
  })

  test("a tree state digests the whole directory and changes with any file in it", () => {
    box = sandbox()
    const d = box.path("data", "tree")
    mkdirSync(`${d}/bin`, { recursive: true })
    writeFileSync(`${d}/bin/tool`, "v1", { mode: 0o755 })
    const one = fileState(nodeFs, d, { tree: true })
    expect(one.exists && one.sha256?.startsWith("sha256:")).toBe(true)
    expect(fileState(nodeFs, d, { tree: true })).toEqual(one)
    writeFileSync(`${d}/bin/tool`, "v2")
    expect(fileState(nodeFs, d, { tree: true }).sha256).not.toBe(one.sha256)
  })
})

describe("resolveTarget", () => {
  test("resolves a PathRef inside its root", () => {
    box = sandbox()
    expect(resolveTarget({ root: "config", rel: "hub/node.json" }, box.roots, nodeFs)).toEqual({ ok: true, value: box.path("config", "hub/node.json") })
  })

  test("refuses traversal, unsafe and unmapped references", () => {
    box = sandbox()
    for (const rel of ["../../.ssh/authorized_keys", "/etc/passwd", "hub\\..\\x", "a/./b", "a//b", "x\u0000y"]) {
      const r = resolveTarget({ root: "config", rel }, box.roots, nodeFs)
      expect(r.ok ? "ok" : r.code).toBe("invalid")
    }
    const unmapped = resolveTarget({ root: "systemd-user", rel: "x.service" }, box.roots, nodeFs)
    expect(unmapped.ok ? "ok" : unmapped.code).toBe("invalid")
  })

  test("refuses any symlink between the root and the target, including the target itself", () => {
    box = sandbox()
    mkdirSync(`${box.dir}/dotfiles/opencode`, { recursive: true })
    symlinkSync(`${box.dir}/dotfiles/opencode`, box.path("config", "opencode"))
    const through = resolveTarget({ root: "config", rel: "opencode/opencode.json" }, box.roots, nodeFs)
    expect(through.ok ? "ok" : through.code).toBe("conflict")
    symlinkSync(`${box.dir}/dotfiles/x.json`, box.path("config", "x.json"))
    const final = resolveTarget({ root: "config", rel: "x.json" }, box.roots, nodeFs)
    expect(final.ok ? "ok" : final.code).toBe("conflict")
    // A link the plan itself manages (link-executable) may be a symlink at the final component only.
    expect(resolveTarget({ root: "config", rel: "x.json" }, box.roots, nodeFs, { finalMayBeSymlink: true }).ok).toBe(true)
    const parent = resolveTarget({ root: "config", rel: "opencode/x" }, box.roots, nodeFs, { finalMayBeSymlink: true })
    expect(parent.ok ? "ok" : parent.code).toBe("conflict")
  })

  test("refuses a path through a regular file", () => {
    box = sandbox()
    writeFileSync(box.path("config", "hub"), "not a dir")
    const r = resolveTarget({ root: "config", rel: "hub/node.json" }, box.roots, nodeFs)
    expect(r.ok ? "ok" : r.code).toBe("conflict")
  })
})

describe("apply lock", () => {
  const io = (patch: Partial<LockIO> = {}): LockIO => ({
    fs: nodeFs,
    path: box.path("state", "hub/bootstrap/apply.lock"),
    hostFingerprint: HOST,
    pid: 100,
    now: () => T0,
    isAlive: () => true,
    ...patch,
  })
  const setup = () => {
    box = sandbox()
    mkdirSync(box.path("state", "hub/bootstrap"), { recursive: true })
  }

  test("acquires a free lock: a valid, owner-only lock document", () => {
    setup()
    const a = tryAcquireLock(io(), "tx_one")
    expect(a.state).toBe("acquired")
    const raw = JSON.parse(readFileSync(io().path, "utf8"))
    expect(validateApplyLock(raw).ok).toBe(true)
    expect(raw).toMatchObject({ pid: 100, txID: "tx_one", hostFingerprint: HOST, acquiredAt: T0, expiresAt: T0 + LOCK_MAX_MS })
    expect(statSync(io().path).mode & 0o777).toBe(0o600)
  })

  test("a live holder on this host is held; another host's lock is foreign and never broken", () => {
    setup()
    expect(tryAcquireLock(io(), "tx_one").state).toBe("acquired")
    expect(tryAcquireLock(io({ pid: 200 }), "tx_two").state).toBe("held")
    expect(tryAcquireLock(io({ hostFingerprint: OTHER_HOST }), "tx_two").state).toBe("foreign")
    const foreign = tryAcquireLock(io({ hostFingerprint: OTHER_HOST, isAlive: () => false, now: () => T0 + 2 * LOCK_MAX_MS }), "tx_two")
    expect(foreign.state).toBe("foreign")
  })

  test("a dead holder or an overrun lock is stale; breaking it then lets a new apply in", () => {
    setup()
    tryAcquireLock(io(), "tx_one")
    const dead = tryAcquireLock(io({ isAlive: () => false }), "tx_two")
    expect(dead.state).toBe("stale")
    const overrun = tryAcquireLock(io({ now: () => T0 + LOCK_MAX_MS }), "tx_two")
    expect(overrun.state).toBe("stale")
    if (dead.state !== "stale") return
    expect(breakStaleLock(io(), dead.lock)).toBe(true)
    expect(tryAcquireLock(io({ pid: 200 }), "tx_two").state).toBe("acquired")
  })

  test("breaking refuses when the lock changed since it was judged stale", () => {
    setup()
    tryAcquireLock(io(), "tx_one")
    const observed: ApplyLock = { ...(JSON.parse(readFileSync(io().path, "utf8")) as ApplyLock), txID: "tx_other" }
    expect(breakStaleLock(io(), observed)).toBe(false)
    expect(JSON.parse(readFileSync(io().path, "utf8")).txID).toBe("tx_one")
  })

  test("a corrupt lock is never broken automatically", () => {
    setup()
    writeFileSync(io().path, "{garbage")
    expect(tryAcquireLock(io(), "tx_one").state).toBe("corrupt")
  })

  test("release only removes our own lock; renew extends it", () => {
    setup()
    const a = tryAcquireLock(io(), "tx_one")
    releaseLock(io(), "tx_two")
    expect(tryAcquireLock(io({ pid: 200 }), "tx_two").state).toBe("held")
    if (a.state !== "acquired") return
    const renewed = renewLock(io({ now: () => T0 + 10_000 }), a.lock)
    expect(renewed.expiresAt).toBe(T0 + 10_000 + LOCK_MAX_MS)
    expect(JSON.parse(readFileSync(io().path, "utf8")).expiresAt).toBe(renewed.expiresAt)
    releaseLock(io(), "tx_one")
    expect(tryAcquireLock(io({ pid: 200 }), "tx_two").state).toBe("acquired")
  })
})
