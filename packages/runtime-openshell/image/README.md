# hub sandbox image

What an OpenShell sandbox of `hub node` runs (design §6.4, decision lk6gn3u7, spike report gut64rwq): Debian
bookworm-slim with git, bash, ca-certificates, curl and procps, the pinned Linux OpenCode
(`@opencode/cli-linux-<arch>@OPENCODE_VERSION` from npm, checked against the registry's sha512), the hub plugin
(this repository's package, installed with its production dependencies) and two scripts.

| File | What |
|---|---|
| `image.ts` | Names, layout and the commands the runtime and `build.ts` run (pure) |
| `build.ts` | Stages the layout, builds the image (`docker build`), or packs the bootstrap tarball |
| `Dockerfile` | The image, built from the staged context only |
| `start.sh` → `bin/hub-sandbox-start` | Starts the entry detached (`setsid nohup`, log `.hub/harness.log`) and returns |
| `entry.sh` → `bin/hub-sandbox-entry` | Waits for the start op, runs and supervises `opencode serve --service` |

## Layout

The same under both roots, so one entry script serves both:

```
<root>/bin/opencode                       IMAGE_ROOT     = /usr/local          (the image)
<root>/bin/hub-sandbox-start              BOOTSTRAP_ROOT = /sandbox/.hub/opt   (the upload fallback)
<root>/bin/hub-sandbox-entry
<root>/lib/hub/node_modules/@huynle/hub   the plugin
```

## Contract with the runtime

1. Create the sandbox **without a main command** (it stays Ready; a main command that ends moves it to Completed and
   exec is refused).
2. Exec `startCommand(root)` (`/usr/local/bin/hub-sandbox-start`) at any point; it returns at once and a second call
   does nothing while the entry runs.
3. Upload `.hub/config.json` (`{hubURL, token, launchID}`, read by the plugin's spoke, never by the scripts),
   optionally `.hub/env.json` (a JSON object of extra variables), then touch `.hub/ready`. The entry waits for both
   `config.json` and `ready`.
4. The entry sets `OPENCODE_DISABLE_MODELS_FETCH/AUTOUPDATE/PROJECT_CONFIG=1`, `XDG_*_HOME=/sandbox/.xdg/*`,
   `HUB_LAUNCH_CONFIG`, a random `OPENCODE_PASSWORD` unless given, and writes the global OpenCode config loading the
   plugin. `env.json` cannot override those, `PATH`, `HOME`, `BUN_*`/`LD_*` or OpenShell's CA variables
   (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, …), which are kept as OpenShell injected them: Bun trusts the proxy CA only
   through them. An invalid `env.json` ends the entry with status 2.
5. It runs `opencode serve --service --hostname 127.0.0.1 --port 4096` in `/sandbox/work` (else `/sandbox`) and sends
   one authorized request so the server loads its instance and the plugin.
6. `.hub/stop` holding `graceful` (SIGTERM, SIGKILL after `HUB_STOP_GRACE`, 10 s) or `kill` (SIGKILL) stops it;
   `.hub/exited` then holds the exit code. `.hub/entry.pid` and `.hub/harness.pid` exist while they run.

## Build

```sh
bun packages/runtime-openshell/image/build.ts image [--arch arm64|x64] [--tag NAME:TAG]   # docker build, never pushes
bun packages/runtime-openshell/image/build.ts bootstrap [--arch arm64|x64] [--out FILE.tgz]
bun packages/runtime-openshell/image/build.ts stage --out DIR [--arch arm64|x64]
```

The default tag is `hub-sandbox:<hub version>-opencode<OpenCode version>`; the architecture defaults to the host's.
`HUB_IT_DOCKER=1 bun test packages/runtime-openshell/test/image-docker.it.test.ts` builds it under a throwaway tag,
checks it and removes it.

## Publishing (deliberate, not automated)

OpenShell's vm driver does **not** use local Docker images: it pulls from an **HTTPS registry** (a plain-http local
registry is refused, rootfs tarballs need the gateway's `allow_driver_config`, and local images only work when the
gateway itself sees a container engine through `DOCKER_HOST` or `/var/run/docker.sock`, an operator choice). To use the
image, publish it, for example:

```sh
bun packages/runtime-openshell/image/build.ts image --arch arm64 --tag ghcr.io/<owner>/hub-sandbox:<tag>
docker push ghcr.io/<owner>/hub-sandbox:<tag>   # or a multi-arch manifest built per architecture
```

and point the node at it (`openshell.profiles.<name>.image` in node.json, or the runtime's default image).

## Upload fallback (gateways that cannot pull the image)

On the gateway's default image (`nvcr.io/nvidia/base/ubuntu:24.04`; `/usr` read-only), the runtime uploads the
bootstrap tarball under `/sandbox/.hub/`, runs `bootstrapCommands(uploaded)` (unpack into `/sandbox/.hub/opt`, remove
the tarball) and then `startCommand(BOOTSTRAP_ROOT)`. Two limits: the sandbox policy must allow
`harnessBinary(BOOTSTRAP_ROOT)` (`/sandbox/.hub/opt/bin/opencode`) instead of `/usr/local/bin/opencode`, and that
image has no git (the runtime's clone and collect need it), so the fallback needs git from elsewhere.
