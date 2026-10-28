// The optional hub_bootstrap Ansible role (contrib/ansible). Checked statically, without any host: the role only
// stages the pinned hubctl and delegates to `hubctl setup preview / apply / verify`; it has no shell, no service
// tasks of its own, no escalation, no enrollment; check mode runs the preview only; and it accepts exactly the vars
// the renderer produces. When ansible-playbook (or python3) is installed, the syntax check (and the canonical
// profile JSON) are checked for real; otherwise those tests are skipped.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { canonicalJSON, digestOf, findSecrets, manifestPayload, verifyManifest, type ArtifactManifest } from "../src/bootstrap/contracts/index.ts"
import { ROLE_FLAGS, renderRoleVars, type RoleVars } from "../src/bootstrap/ansible/index.ts"
import { generateKeyPairSync, sign } from "node:crypto"
import * as F from "./bootstrap/fixtures.ts"

const CONTRIB = path.resolve(import.meta.dir, "../../../contrib/ansible")
const ROLE = path.join(CONTRIB, "roles/hub_bootstrap")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

const yamlFiles = () => files(CONTRIB).filter((f) => /\.ya?ml$/.test(f))
const load = (rel: string): any => Bun.YAML.parse(readFileSync(path.join(ROLE, rel), "utf8"))

const KEYWORDS = new Set([
  "name", "when", "register", "changed_when", "failed_when", "check_mode", "loop", "loop_control", "vars", "tags", "no_log",
  "become", "diff", "ignore_errors", "notify", "args", "environment", "until", "retries", "delay", "block", "rescue", "always",
])

type Task = Record<string, any>

function tasksOf(list: unknown): Task[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((t: Task) => [t, ...tasksOf(t.block), ...tasksOf(t.rescue), ...tasksOf(t.always)])
}

const allTasks = (): Task[] => files(path.join(ROLE, "tasks")).flatMap((f) => tasksOf(Bun.YAML.parse(readFileSync(f, "utf8"))))
const moduleOf = (t: Task) => Object.keys(t).find((k) => !KEYWORDS.has(k))
const commandTasks = () => allTasks().filter((t) => moduleOf(t) === "ansible.builtin.command")
const argvText = (t: Task) => String(t["ansible.builtin.command"]?.argv ?? "")
const whenText = (t: Task) => [t.when ?? []].flat().join(" and ")

function renderedVars(): RoleVars {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const manifest: ArtifactManifest = { ...F.MANIFEST_UNSIGNED, signatures: [{ keyID: "k", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(F.MANIFEST_UNSIGNED)), privateKey).toString("base64") }] }
  const v = verifyManifest(manifest, { ...F.TRUST_ROOT_TEMPLATE, keys: [{ keyID: "k", algorithm: "ed25519", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), status: "active" }] })
  if (!v.ok) throw new Error("manifest")
  const r = renderRoleVars({ profile: F.PROFILE_FULL_HARNESS, manifest: v.value, options: { releaseBaseURL: "https://github.com/huynle/hub/releases/download/v0.8.0" } })
  if (!r.ok) throw new Error(r.error.message)
  return r.vars
}

describe("hub_bootstrap role layout", () => {
  test("the role, its argument spec and an example playbook exist and parse", () => {
    for (const rel of ["tasks/main.yml", "defaults/main.yml", "vars/main.yml", "meta/main.yml", "meta/argument_specs.yml", "README.md"]) expect(statSync(path.join(ROLE, rel)).isFile()).toBe(true)
    expect(statSync(path.join(CONTRIB, "hub-bootstrap.yml")).isFile()).toBe(true)
    for (const f of yamlFiles()) expect(() => Bun.YAML.parse(readFileSync(f, "utf8"))).not.toThrow()
  })

  test("accepts exactly the vars the renderer produces, with matching types", () => {
    const options = load("meta/argument_specs.yml").argument_specs.main.options as Record<string, { type: string; required?: boolean }>
    const vars = renderedVars()
    const typeOf = (v: unknown) => (v === null ? "raw" : Array.isArray(v) ? "list" : typeof v === "object" ? "dict" : typeof v === "boolean" ? "bool" : typeof v === "number" ? "int" : "str")
    for (const [key, value] of Object.entries(vars)) {
      expect(options[key], key).toBeDefined()
      expect([typeOf(value), "raw"]).toContain(options[key]!.type)
    }
    for (const [key, spec] of Object.entries(options)) if (spec.required) expect(Object.keys(vars)).toContain(key)
  })

  test("consent is off by default and readiness is required by default", () => {
    const defaults = load("defaults/main.yml")
    for (const key of Object.keys(ROLE_FLAGS)) expect(defaults[key]).toBe(false)
    expect(defaults.hub_bootstrap_require_ready).toBe(true)
  })

  test("each consent var becomes exactly its hubctl flag", () => {
    const expr = String(load("vars/main.yml")._hub_bootstrap_consent_flags)
    for (const [key, flag] of Object.entries(ROLE_FLAGS)) expect(expr).toContain(`['${flag}'] if ${key} | bool`)
    expect([...(expr.match(/--[a-z-]+/g) ?? [])].sort()).toEqual([...Object.values(ROLE_FLAGS)].sort())
  })
})

describe("the role delegates to hubctl and reimplements nothing", () => {
  test("uses only fully qualified, non-shell modules (no service, package or privilege tasks)", () => {
    const allowed = new Set(["ansible.builtin.assert", "ansible.builtin.command", "ansible.builtin.get_url", "ansible.builtin.file", "ansible.builtin.slurp", "ansible.builtin.set_fact", "ansible.builtin.debug", "ansible.builtin.import_tasks", "ansible.builtin.fail"])
    const tasks = allTasks()
    expect(tasks.length).toBeGreaterThan(5)
    for (const t of tasks) if (!t.block) expect(allowed, `${t.name}: ${moduleOf(t)}`).toContain(moduleOf(t)!)
  })

  test("every command is an argv word list, never a shell string", () => {
    expect(commandTasks().length).toBeGreaterThanOrEqual(4)
    for (const t of commandTasks()) {
      expect(typeof t["ansible.builtin.command"], t.name).toBe("object")
      expect(t["ansible.builtin.command"].argv, t.name).toBeDefined()
      expect(t["ansible.builtin.command"].cmd, t.name).toBeUndefined()
    }
  })

  test("never escalates through Ansible", () => {
    for (const f of yamlFiles()) expect(readFileSync(f, "utf8")).not.toMatch(/^\s*become:\s*(true|yes)/m)
  })

  test("the hubctl download is checked against the pinned digest", () => {
    const download = allTasks().find((t) => moduleOf(t) === "ansible.builtin.get_url" && String(t["ansible.builtin.get_url"].url).includes("_hub_bootstrap_artifact.url"))
    expect(download).toBeDefined()
    expect(String(download!["ansible.builtin.get_url"].checksum)).toContain("_hub_bootstrap_artifact.sha256")
  })

  test("the downloaded manifest must carry the rendered pins before hubctl checks its signature", () => {
    const text = readFileSync(path.join(ROLE, "tasks/stage.yml"), "utf8")
    for (const v of ["hub_bootstrap_release", "hub_bootstrap_minimum_version", "_hub_bootstrap_artifact.sha256", "hub_bootstrap_harness_pins"]) expect(text).toContain(v)
    const preview = commandTasks().find((t) => argvText(t).includes("'preview'"))
    expect(argvText(preview!)).toContain("'--manifest', _hub_bootstrap_manifest")
  })
})

describe("check mode runs the preview only", () => {
  test("the preview is read-only and runs in check mode", () => {
    const preview = commandTasks().find((t) => argvText(t).includes("'setup', 'preview'"))
    expect(preview).toBeDefined()
    expect(preview!.check_mode).toBe(false)
    expect(preview!.changed_when).toBe(false)
    expect(argvText(preview!)).toContain("'--profile', '-'")
  })

  test("apply and verify never run in check mode", () => {
    const mutating = commandTasks().filter((t) => /'setup', '(apply|verify|recover)'/.test(argvText(t)))
    expect(mutating.length).toBe(2)
    for (const t of mutating) expect(whenText(t)).toContain("not ansible_check_mode")
  })

  test("apply runs only when the preview has changes (idempotent services and files)", () => {
    const apply = commandTasks().find((t) => argvText(t).includes("'setup', 'apply'"))!
    expect(whenText(apply)).toContain("_hub_bootstrap_pending | length > 0")
    expect(argvText(apply)).toContain("_hub_bootstrap_consent_flags")
    expect(argvText(apply)).toContain("'--preview', _hub_bootstrap_preview_file")
  })

  test("check mode reports the pending changes, and diff mode shows them", () => {
    const report = allTasks().find((t) => String(t.changed_when ?? "").includes("ansible_check_mode") && String(t.changed_when).includes("_hub_bootstrap_pending"))
    expect(report).toBeDefined()
    expect(allTasks().some((t) => moduleOf(t) === "ansible.builtin.debug" && whenText(t).includes("ansible_diff_mode"))).toBe(true)
  })

  test("only the content-checked hubctl cache is written in check mode, and that is opt-out", () => {
    const forced = allTasks().filter((t) => t.check_mode !== undefined && t.check_mode !== false && moduleOf(t) !== "ansible.builtin.command")
    for (const t of forced) expect(String(t.check_mode)).toContain("hub_bootstrap_stage_in_check_mode")
    for (const t of allTasks().filter((t) => t.check_mode === false)) expect(["ansible.builtin.command", "ansible.builtin.slurp"]).toContain(moduleOf(t)!)
  })
})

describe("plan semantics and safety", () => {
  test("the role hands hubctl the canonical profile and checks its digest", () => {
    expect(String(load("vars/main.yml")._hub_bootstrap_profile_json)).toContain("to_json(sort_keys=True, separators=[',', ':'])")
    const text = readFileSync(path.join(ROLE, "tasks/preview.yml"), "utf8")
    expect(text).toContain("_hub_bootstrap_profile_json | hash('sha256')")
    expect(text).toContain("hub_bootstrap_profile_digest")
  })

  test.if(spawnSync("python3", ["-c", "1"]).status === 0)("python's sorted compact JSON is the contract's canonical JSON for every profile", () => {
    for (const p of [F.PROFILE_SESSION_ONLY, F.PROFILE_LAUNCH_NODE, F.PROFILE_FULL_HARNESS]) {
      const out = spawnSync("python3", ["-c", "import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(',', ':')))"], { input: JSON.stringify(p) })
      expect(out.stdout.toString()).toBe(canonicalJSON(p))
      expect(digestOf(p)).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(out.stdout).digest("hex")}`)
    }
  }, 60_000)

  test("binds to the previewed plan when rendered from one, and refuses blockers, enrollment and missing consent", () => {
    const text = readFileSync(path.join(ROLE, "tasks/preview.yml"), "utf8")
    for (const s of ["hub_bootstrap_expected_plan.planDigest", "hub_bootstrap_expected_plan.hostFingerprint", "hub_bootstrap_expected_plan.snapshotDigest", "blockers", "enroll-machine", "requiresEscalation", "activatesServices"])
      expect(text).toContain(s)
  })

  test("enrollment stays a separate, explicit step", () => {
    for (const t of commandTasks()) expect(argvText(t)).not.toContain("enroll")
  })

  test("no file carries a credential or a private reference", () => {
    for (const f of files(CONTRIB)) {
      const text = readFileSync(f, "utf8")
      expect(text).not.toContain("hub-plans")
      if (/\.ya?ml$/.test(f)) expect(findSecrets(Bun.YAML.parse(text)), f).toEqual([])
      else expect(findSecrets(text), f).toEqual([])
    }
  })
})

const ansible = spawnSync("ansible-playbook", ["--version"]).status === 0

describe("ansible tooling", () => {
  test.if(ansible)("ansible-playbook --syntax-check passes on the example playbook", () => {
    const r = spawnSync("ansible-playbook", ["--syntax-check", "-i", "localhost,", path.join(CONTRIB, "hub-bootstrap.yml")], { env: { ...process.env, ANSIBLE_NOCOLOR: "1" } })
    expect(r.stderr.toString() + r.stdout.toString()).toContain("playbook: ")
    expect(r.status).toBe(0)
  }, 120_000)
})
