# OpenCode harness adapter (HBS-06)

The OpenCode `HarnessAdapter` for the bootstrap (contracts §3.10, §3.6.1, §3.12.1 and §5 in
`docs/bootstrap-contracts.md`). It only imports the frozen contracts and the transaction, discovery and preview
modules. Every capability is injected.

| File | Role |
|---|---|
| `config.ts` | Reads an OpenCode 2 config (JSONC) and classifies the Hub plugin entry and the `hub` MCP server: absent, registered, drift, or a refusal. It computes the exact JSON-pointer sets for the lossless merge. |
| `plan.ts` | `planOpencode` and `createOpencodeAdapter`. The pinned `install-harness` comes first, then `select-harness-version`, `merge-config` (plugin), `register-mcp-server` and `verify-harness`. The planner is pure and deterministic. |
| `verify.ts` | Real readiness probes through a fixed-argv `ProcessRunner` (no shell). `locateOpencodeBinary` finds the binary that really runs. |
| `archive.ts` | A pure unpacker for the upstream zip and tar.gz. It accepts exactly one regular file, `opencode`, and writes it to `bin/opencode` with mode 0755. |
| `apply.ts` | The `HarnessSource` (the pinned URL only, https only, bounded by the pinned size), the `register-mcp-server` and `verify-harness` executors, and `httpsDownload`. |
| `index.ts` | `createOpencodeHarness`, the single entry point for the integrator. |

## Behaviour

- **Install.** OpenCode is installed only from the pin in hub's verified manifest for the host's exact target, into
  `data:hub/harnesses/opencode/<version>`. That version is then made `current`.
  - An OpenCode the user installed (native, brew or npm) is kept by default (`install: "if-missing"`).
  - A hub-managed OpenCode at an older version gets the pinned version installed next to it. A newer one is never
    downgraded by planning.
  - Without a pin, a missing OpenCode is `unpinned_artifact`.
  - A pin below 2.0.0 is refused, because the Hub plugin needs OpenCode 2.
- **Config.** OpenCode 2 uses `plugins: (string | {package, options?})[]` and `mcp.servers.<name>` (from
  `@opencode/schema` 2.0.26, `config/plugin.js` and `mcp.js`). hubctl edits `config:opencode/opencode.jsonc` if it
  exists, otherwise `opencode.json`. When neither exists, it creates `opencode.json`. The config is read only if
  the snapshot lists it, and must still have the snapshot's digest, otherwise `preview_stale`.
  - **Plugin.** If the Hub plugin is absent, it is appended to `/plugins`.
    - These count as registered: an exact npm entry, an unpinned npm entry, or a custom source (a `github:huynle/hub`
      spec or a checkout named `hub`).
    - These are drift, fixed by one set on that entry (or on its `package` field only): an older pin, or the legacy
      `@huynle/opencode-voice`.
    - These are refused as `conflict`: a duplicate (including across `plugins` and the OpenCode 1 key `plugin`, or
      across both files), or a pin newer than this hubctl.
  - **MCP.** `mcp.servers.hub = {type: "local", command: [<authority>, "mcp"]}`.
    - A `hub`/`hubctl mcp` server at another path (the plugin's launcher in the state dir, or a plugin cache) is
      stale. Only its `command` is replaced; `environment`, `disabled` and other fields stay.
    - These are refused: a foreign server named `hub`, or hub's MCP server under another name.
  - **Authority.** The authority is `user-bin:hubctl` by default, or `user-bin:hub` (the same command surface). Any
    other root or name (`state:hub/bin/…`, `data:…/node_modules/…`) is refused when the adapter is built.
  - **Unparseable files.** Unparseable JSONC, or JSONC with duplicate keys, is `manual_edit_required`.
- **Symlinked configs.** The adapter plans normally. `planSetup` replaces both config actions with `symlinked-config`
  manual edits that name the dotfiles file. Nothing is written through the link.
- **Readiness.** A planned or applied install is never readiness. The three required probes are:
  - `version-exec`: `<binary> --version` must report OpenCode ≥ 2.0.0, and exactly the hub `current` version when
    hub manages the binary. The binary is hub's `current` binary, otherwise what PATH resolves to. A container shim
    is refused.
  - `provider-auth`: `<binary> models` must list at least one `provider/model`. This sends no prompt and costs
    nothing. A stronger `ProviderProbe` can be injected.
  - `spoke-connected`: an injected `SpokeProbe`. Without one, the probe fails, so OpenCode is never ready by default.

  Details are built by the adapter, never copied from harness output. Anything that looks like a credential is
  withheld. The child process gets the user's own environment, and nothing from it is recorded.
- **Rollback.** All rollback goes through the engine. The new version directory is removed, `current` is restored
  from its backup, and the config is restored from its backup, except when the user changed it after hub wrote it.
  Then it is kept and reported as a conflict (`bootstrap-adapter-opencode-apply.test.ts`).

## Upstream source of OpenCode 2.x (researched 2026-10-28)

| Channel | Finding | Source |
|---|---|---|
| GitHub releases | `sst/opencode` redirects to **`anomalyco/opencode`** (HTTP 301). The 2.x CLI is published there as tag **`v2.2.0`** (2026-10-27, by github-actions[bot], from `dev`). The same repository still ships a **1.x line** (`v1.19.5`, 2026-10-28). Because 1.19.5 is newer, GitHub's "latest release" is the 1.x line: never use `latest`, pin the exact tag. | https://github.com/anomalyco/opencode/releases/tag/v2.2.0, https://api.github.com/repos/anomalyco/opencode/releases |
| Release assets (v2.2.0) | CLI archives: `opencode-darwin-arm64.zip`, `opencode-darwin-x64.zip` (and `-baseline`), `opencode-linux-x64.tar.gz` (and `-baseline`, `-musl`, `-baseline-musl`), `opencode-linux-arm64.tar.gz` (and `-musl`), plus Windows zips, `opencode-desktop-*` apps and a `SHA256SUMS` file. | release page above |
| Archive layout | Checked with HTTP range reads, without downloading the archives. The zip has one entry, `opencode` (deflate, unix mode 0100755, 220 826 080 bytes uncompressed). The tar.gz has one ustar (GNU) entry, `opencode`, mode 0755. The uncompressed darwin-arm64 size equals the size of the locally installed `~/.opencode/bin/opencode`, which reports `opencode v2.2.0`. | range requests on the asset URLs |
| Authenticity | No signatures: no `.sig`, `.asc`, `.sigstore` or attestation assets. `SHA256SUMS` is unsigned. GitHub's API reports a per-asset `digest`. Both only help to cross-check the pinned digest (contract §5: OpenCode is vouched for only by hub's pin). | release API `assets[].digest`, `SHA256SUMS` |
| npm `opencode-ai` | dist-tag `latest` = **1.19.5**. No 2.x versions are published: this is the 1.x line. | https://registry.npmjs.org/opencode-ai |
| npm `@opencode/cli` | dist-tag `latest` = **2.2.0**, repository `anomalyco/opencode`. This is the 2.x CLI on npm under its new name. The SDK this repo uses (`@opencode/client`, `@opencode/plugin` ^2.0.26) comes from the same repository. | https://registry.npmjs.org/@opencode%2fcli |

**Recommendation.** Pin the **GitHub release archives of `anomalyco/opencode`, exact tag `v2.x.y`**, not npm:

- An npm install runs a package manager, with lifecycle scripts and platform-specific optional dependencies. That
  is an installer, which `install-harness` must never carry (T21).
- The release archive is a single file, which hubctl checks against the pin and unpacks itself.

| Target | Asset | Format |
|---|---|---|
| `darwin-arm64` | `opencode-darwin-arm64.zip` | zip (deflate) |
| `darwin-x64` | `opencode-darwin-x64.zip` (the `-baseline` build is for CPUs without AVX2; see the open questions) | zip (deflate) |
| `linux-x64` (glibc) | `opencode-linux-x64.tar.gz` | tar.gz |
| `linux-arm64` (glibc) | `opencode-linux-arm64.tar.gz` | tar.gz |

The musl and Windows assets are out of scope (decision Q7, §3.1). The URL is
`https://github.com/anomalyco/opencode/releases/download/v<version>/<asset>`. `evidence` is always `[]`.

### Proposed `harness-pins.json` entries (template: fill in only from your own download)

```json
{
  "pin": {
    "harness": "opencode",
    "version": "2.2.0",
    "target": "darwin-arm64",
    "url": "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-darwin-arm64.zip",
    "file": "opencode-darwin-arm64.zip",
    "size": "<bytes you measured>",
    "sha256": "sha256:<hex you computed>",
    "evidence": [],
    "minimumVersion": "2.0.0"
  },
  "review": { "by": "<your GitHub handle>", "on": "<YYYY-MM-DD>", "checked": ["upstream-release", "digest-redownloaded", "evidence-listed"] }
}
```

Repeat the entry for `darwin-x64` (`opencode-darwin-x64.zip`), `linux-x64` (`opencode-linux-x64.tar.gz`) and
`linux-arm64` (`opencode-linux-arm64.tar.gz`). `size` must be an integer. The placeholders above are deliberately
invalid, so an unfilled template fails `bootstrap-release-pins.test.ts`.

### Reviewer instructions

1. Open the release page for the tag. Confirm it is the 2.x line, published by the upstream workflow, and that the
   asset name is exactly the target's asset in the table above.
2. Download the asset yourself, then measure and hash it:
   `curl -fsSLo f "$URL" && wc -c < f && shasum -a 256 f`.
3. Cross-check against both upstream values: the asset's line in the release's `SHA256SUMS`, and `assets[].digest`
   from `https://api.github.com/repos/anomalyco/opencode/releases/tags/v<version>`. If any value differs, stop.
4. List the archive and confirm it holds exactly one regular file, `opencode`: `unzip -Z1 f` or `tar -tzvf f`. The
   adapter refuses anything else.
5. Keep `evidence: []`, because OpenCode publishes no signatures. Set `minimumVersion` to `2.0.0`, or higher to
   raise the floor after a security release.
6. Fill in `review` and open the PR. Someone other than the author reviews it (`release/README.md`).

## Integration requirements (HBS-13)

These are the edits needed in files this task does not own:

- **Construction.** `packages/cli/src/cli.ts` (setup preview, apply and recover):
  - Build `createOpencodeHarness({ probe: createNodeProbe(), manifest: <verified manifest>, pluginVersion?: <hubctl
    version>, spoke: <SpokeProbe>, installed, floor, allowDowngrade })`.
  - Register `.adapter` in the `AdapterRegistry` passed to **both** `previewSetup` and `revalidateApply`, with
    identical options, so the plan digests match.
- **Refusals.** `planSetup` calls `adapter.plan()`, which **throws `OpencodePlanError`** (`code`: `conflict`,
  `manual_edit_required`, `unpinned_artifact`, `preview_stale` or `invalid`). Catch it around
  `previewSetup`/`revalidateApply` and print it as the envelope error with `exitFor(code)`. Amendment A1 would make
  this unnecessary.
- **Executors.** The `ExecutorMap` holds one executor per kind. `register-mcp-server` and `verify-harness` must
  dispatch on `action.harness` to each adapter's executor: `harness.executors(() => adapterContext)` for OpenCode.
  `builtinExecutors({ harness })` takes one `HarnessSource`, so the integrator needs a source that dispatches on
  `action.harness` (OpenCode: `harness.source`). See A2.
- **Adapter context.** `AdapterContext.env` must be the user's real `process.env`: the provider probe needs the user's
  own provider configuration. `now: Date.now`.
- **Spoke probe.** The hub needs a machine-credential query that answers "is an OpenCode spoke of this machine
  connected?". Today `GET /api/machines` (user auth) lists `processes` per machine. Without a `SpokeProbe`, OpenCode
  is never ready, which is correct but blocks every apply.
- **Authority.** The MCP server runs `user-bin:hubctl`, which this plan's `install-artifact` installs.
  `src/spoke/launchers.ts` writes `hub`/`hubctl` launchers into the hub state dir that run the CLI bundle from the
  plugin's install (cache) directory. They must not become what services or MCP clients depend on. Suggested
  change: when a standalone `user-bin:hubctl` exists, the launchers exec it instead of the bundle.
- **No dependencies.** No new dependency and no `package.json` change. zlib, `child_process` and fetch come from the
  runtime.

## Amendment requests (contracts are not modified here)

- **A1.** `HarnessAdapter.plan` returns only `Action[]`, so it cannot report a refusal or findings (drift, unpinned
  plugin, stale MCP authority).
  - Proposal: `plan` may return `{ actions, findings?, refusal?: {code, message} }`, or `planSetup` catches a
    contract-defined `PlanRefusal` and returns it as a failed `Result`. Findings would appear in the `SetupPreview`
    (a new optional `findings[]`).
- **A2.** `ExecutorMap` and `BuiltinDeps.harness` allow one executor and one source per kind, but three adapters
  each supply `register-mcp-server`, `verify-harness` and a `HarnessSource`.
  - Proposal: a `harnessDispatch` helper in `transaction/`, or `ExecutorMap` entries keyed `kind` →
    `Record<HarnessID, ActionExecutor>` for harness-scoped kinds.
- **A3.** An unparseable JSONC config is only a bare `manual_edit_required` at plan time. The planner turns TOML,
  not broken JSONC, into an `unmergeable-format` manual edit.
  - Proposal: let an adapter mark a config action unmergeable, so the user gets the structured edit.
- **A4.** The shared fixtures use OpenCode 1 keys: `ACTIONS["merge-config"]` sets `/plugin/-`, and the discovery
  fixture's `OPENCODE_CONFIG` has `plugin: []`. OpenCode 2 uses `plugins`.
- **A5.** `install-harness.previous` and `select-harness-version.previous` need a `sha256` of the previous version,
  which discovery does not record, so the adapter omits `previous`.
  - Proposal: discovery records the tree digest of a hub-managed version directory, or the history supplies it.
- **A6.** Nothing puts a hub-installed OpenCode on PATH, because `link-executable` is reserved for the hub ↔ hubctl
  alias.
  - Proposal: allow `link-executable` from `user-bin:opencode` to `harnessCurrentRef("opencode")/bin/opencode`, or
    decide that services and launches always use the absolute path.

## Open questions

- Should the plugin default to being pinned to hubctl's own version? Today it is unpinned unless `pluginVersion` is
  passed, and an existing unpinned entry is kept as the user's choice.
- On `darwin-x64`, should hubctl pin the `-baseline` build (it works on every Intel Mac) or the AVX2 build?
- `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` and project-level configs are not considered: discovery reports only
  `config:opencode/opencode.json(c)`.
- Is `opencode models` strong enough as `provider-auth`, or should HBS-13 inject a one-token completion probe that
  costs money?
- `opencode models` talks to the background service by default (the 2.x CLI also has `--standalone`). Should the
  probe pin `--standalone`, so it tests exactly the binary that was installed?
