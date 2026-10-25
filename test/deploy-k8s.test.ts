// deploy/k8s must agree with the hub's code: the drain fits the grace period, the probes hit the right endpoints,
// every pod gets its own HUB_POD_ID, and the Secret template holds placeholders only. (Schema validation is
// kubeconform's job; see docs/cluster.md.)
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DRAIN_TIMEOUT_MS } from "../src/central/spoke-ws"

const dir = path.join(import.meta.dir, "..", "deploy", "k8s")
type Doc = any
const docs = (file: string): Doc[] => {
  const parsed = Bun.YAML.parse(readFileSync(path.join(dir, file), "utf8"))
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}
const one = (file: string, kind: string): Doc => {
  const found = docs(file).filter((d) => d.kind === kind)
  expect(found).toHaveLength(1)
  return found[0]
}

describe("deploy/k8s", () => {
  const deployment = one("deployment.yaml", "Deployment")
  const pod = deployment.spec.template.spec
  const hub = pod.containers[0]
  const env = new Map<string, Doc>(hub.env.map((e: Doc) => [e.name, e]))

  test("two replicas of the published image, rolled without losing capacity", () => {
    expect(deployment.spec.replicas).toBe(2)
    expect(hub.image).toStartWith("ghcr.io/huynle/hub:")
    expect(deployment.spec.strategy.rollingUpdate.maxUnavailable).toBe(0)
  })

  test("each pod's HUB_POD_ID is its name", () => {
    expect(env.get("HUB_POD_ID")?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.name")
  })

  test("readiness on /readyz, liveness on /healthz", () => {
    expect(hub.readinessProbe.httpGet.path).toBe("/readyz")
    expect(hub.livenessProbe.httpGet.path).toBe("/healthz")
  })

  test("preStop sleep and the drain fit the grace period", () => {
    const sleep = Number(hub.lifecycle.preStop.exec.command[1])
    expect(sleep).toBe(5)
    expect(pod.terminationGracePeriodSeconds).toBe(60)
    expect(sleep + DRAIN_TIMEOUT_MS / 1000).toBeLessThan(pod.terminationGracePeriodSeconds)
  })

  test("non-root, read-only root filesystem, a writable state dir", () => {
    expect(pod.securityContext.runAsNonRoot).toBe(true)
    expect(hub.securityContext.readOnlyRootFilesystem).toBe(true)
    expect(hub.securityContext.allowPrivilegeEscalation).toBe(false)
    const state = hub.volumeMounts.find((m: Doc) => m.mountPath === "/data")
    expect(pod.volumes.find((v: Doc) => v.name === state?.name)?.emptyDir).toBeDefined()
  })

  test("cluster settings come from the Secret", () => {
    expect(hub.envFrom[0].secretRef.name).toBe("hub")
    expect(env.get("HUB_AUTH")?.value).toBe("oidc")
    const secret = one("secret.example.yaml", "Secret")
    expect(Object.keys(secret.stringData)).toEqual(
      expect.arrayContaining(["HUB_DATABASE_URL", "HUB_VALKEY_URL", "HUB_TOKEN_KEYS", "HUB_OIDC_CLIENT_ID", "HUB_OIDC_CLIENT_SECRET"]),
    )
    for (const value of Object.values(secret.stringData) as string[]) expect(value).toContain("REPLACE_ME")
  })

  test("no sticky sessions, a PDB keeping one pod", () => {
    expect(one("service.yaml", "Service").spec.sessionAffinity).toBe("None")
    expect(one("pdb.yaml", "PodDisruptionBudget").spec.minAvailable).toBe(1)
    expect(JSON.stringify(docs("ingress.yaml"))).not.toMatch(/affinity|sticky/i)
  })

  test("the migrate Job runs hub-server migrate with the same image", () => {
    const job = one("migrate/job.yaml", "Job")
    const container = job.spec.template.spec.containers[0]
    expect(container.command).toEqual(["bun", "bin/hub.ts", "migrate"])
    expect(container.image).toBe(hub.image)
  })
})
