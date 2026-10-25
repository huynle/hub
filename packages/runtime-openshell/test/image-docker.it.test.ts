// Opt-in (HUB_IT_DOCKER=1, needs a local Docker and the npm registry): builds the hub sandbox image for this host's
// architecture with image/build.ts under a throwaway tag, checks what a sandbox needs (OpenCode at the pinned version,
// git, bash, the hub plugin), runs the start script as OpenShell would (uid 1000, HOME=/sandbox) through a graceful
// stop, and removes the image. Never pushes and never creates an OpenShell sandbox.
import { afterAll, describe, expect, test } from "bun:test"
import { buildImage } from "../image/build.ts"
import { OPENCODE_VERSION, linuxArch, pluginDir } from "../image/image.ts"

const run = process.env.HUB_IT_DOCKER === "1"
const tag = `hub-sandbox-it:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
let built = false

afterAll(() => {
  if (built) Bun.spawnSync(["docker", "image", "rm", "--force", tag])
})

function docker(script: string): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["docker", "run", "--rm", "--user", "1000:1000", "--tmpfs", "/sandbox:rw,exec,uid=1000,gid=1000,mode=0755", "-e", "HOME=/sandbox", "--workdir", "/sandbox", tag, "bash", "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  )
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() }
}

describe.skipIf(!run)("live: the hub sandbox image", () => {
  test(
    "builds",
    async () => {
      await buildImage({ arch: linuxArch(process.arch), tag, log: (l) => console.error(`[it] ${l}`) })
      built = true
      expect(Bun.spawnSync(["docker", "image", "inspect", tag]).exitCode).toBe(0)
    },
    600_000,
  )

  test("has OpenCode at the pinned version, git, bash and the hub plugin", () => {
    const { code, out } = docker(`set -e
      echo "opencode=$(opencode --version)"
      git --version
      bash --version | head -n 1
      command -v curl ps setsid tar
      test -f ${pluginDir()}/server.ts && echo plugin=ok
      test -x /usr/local/bin/hub-sandbox-start && test -x /usr/local/bin/hub-sandbox-entry && echo scripts=ok
      echo "offline=$OPENCODE_DISABLE_MODELS_FETCH$OPENCODE_DISABLE_AUTOUPDATE$OPENCODE_DISABLE_PROJECT_CONFIG"`)
    expect(out).toMatch(new RegExp(`opencode=(opencode v)?${OPENCODE_VERSION.replace(/\./g, "\\.")}\\n`))
    expect(out).toMatch(/git version \d/)
    expect(out).toContain("GNU bash")
    expect(out).toContain("plugin=ok")
    expect(out).toContain("scripts=ok")
    expect(out).toContain("offline=111")
    expect(code).toBe(0)
  }, 120_000)

  test("the start script runs the harness after the start op's files and stops it on .hub/stop", () => {
    const { code, out } = docker(`set -e
      mkdir -p /sandbox/.hub /sandbox/work
      git -C /sandbox/work init -q
      hub-sandbox-start
      sleep 1
      printf '%s' '{"hubURL":"http://127.0.0.1:9","token":"hlt1.it","launchID":"it"}' >/sandbox/.hub/config.json
      echo '{"HUB_IT_EXTRA":"yes"}' >/sandbox/.hub/env.json
      touch /sandbox/.hub/ready
      for i in $(seq 1 90); do grep -q "the harness answered" /sandbox/.hub/harness.log && break; sleep 1; done
      tr '\\0' '\\n' </proc/$(cat /sandbox/.hub/harness.pid)/environ | grep -E '^(HUB_IT_EXTRA|XDG_CONFIG_HOME|OPENCODE_DISABLE_PROJECT_CONFIG)=' | sort
      cat /sandbox/.xdg/config/opencode/opencode.jsonc
      echo graceful >/sandbox/.hub/stop
      for i in $(seq 1 30); do [ -f /sandbox/.hub/exited ] && break; sleep 1; done
      echo "exited=$(cat /sandbox/.hub/exited)"
      cat /sandbox/.hub/harness.log`)
    expect(out).toContain("the harness answered")
    expect(out).toContain("HUB_IT_EXTRA=yes")
    expect(out).toContain("XDG_CONFIG_HOME=/sandbox/.xdg/config")
    expect(out).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1")
    expect(out).toContain(pluginDir())
    // OpenCode ends on SIGTERM (130 here) well within the grace period: no SIGKILL (137).
    expect(out).toMatch(/exited=(0|130|143)\n/)
    expect(out).not.toContain("SIGKILL after 10s\n[hub-sandbox] the harness exited with 137")
    // The plugin's spoke ran (the hub URL here leads nowhere).
    expect(out).toContain("[hub]")
    expect(out).not.toContain("hlt1.it")
    expect(code).toBe(0)
  }, 240_000)
})
