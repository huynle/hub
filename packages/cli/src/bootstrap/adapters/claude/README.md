# Claude Code bootstrap adapter (HBS-08)

This adapter plans, installs and verifies Claude Code for `hubctl setup`. It implements contracts §3.6.1, §3.10 and
§5 of `docs/bootstrap-contracts.md`. It is a pure planner. It reaches outside itself only through injected ports,
and it never gets a shell.

| File | Role |
|---|---|
| `adapter.ts` | `createClaudeAdapter` (a `HarnessAdapter`) and `planClaude`. Plans, in order: pinned `install-harness`, `select-harness-version`, `merge-config` of hub's own `config:hub/claude-code.json`, `verify-harness`. Also `discover()` and `binary()`, both through the read-only `DiscoveryProbe`. |
| `source.ts` | `createClaudeHarnessSource`, the `HarnessSource` for `installHarnessExecutor`. It downloads the pinned file, records the optional evidence and unpacks the single binary into `<version>/claude`. |
| `openpgp.ts` | An in-house check of a detached OpenPGP v4 RSA signature. It verifies upstream's signed `manifest.json` against the pinned release key and needs no `gpg`. |
| `verify.ts` | The real readiness probes, `claudeReadiness` (the capability is offered only when the harness is ready) and `claudeVerifyExecutor`. |
| `ports.ts` / `node.ts` | The injected ports (`Downloader`, `ProbeRunner`, `Scratch`) and their Node defaults (`httpsDownloader`, `nodeRunner`, `tempScratch`). |
| `index.ts` | Re-exports, and `claudeExecutors`: `install-harness` and `verify-harness` for claude-code. |

## Authenticity

The mandatory check is the sha256 that hub's signed manifest pins. `installHarnessExecutor` checks it first,
through `checkHarnessEvidence`. The optional evidence is then recorded as `verified`, `unavailable` or `failed`.
Any `failed` result rejects the artifact.

- **`gpg-manifest`.** The adapter fetches `…/claude-code-releases/<v>/manifest.json`, its `.sig`, and
  `https://downloads.claude.ai/keys/claude-code.asc`. The key's fingerprint must be
  `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` (`CLAUDE_SIGNING_FINGERPRINT`). The signature is a v4 RSA signature
  over a binary document, using SHA-2.
  - `verified`: the signature is good, and the signed manifest lists exactly the pinned version, checksum and size
    for this platform.
  - `failed`: the signature does not verify, the signature is malformed, or the signed manifest lists other bytes
    or another version.
  - `unavailable`: there is no signature (releases before 2.1.89), the bucket cannot be reached, the key is
    another one or a rotated one, the format is unsupported, or the pin URL is outside upstream's bucket.
- **`macos-notarization`.** This check runs on macOS only. It runs `/usr/bin/codesign --verify --strict` (fixed
  argv) on a private copy of the downloaded bytes.
  - It first checks `-R=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"`, which means signed
    by Anthropic PBC. If this fails, the result is `failed`.
  - It then checks `-R=notarized and …`. If this passes, the result is `verified`. If it fails, the result is
    `unavailable`, because the ticket may not be confirmable offline.
  - The result is also `unavailable` when codesign is missing, when the host is not macOS, or when the target is
    Linux.

## User config and credentials

- No plan ever touches `~/.claude` or `~/.claude.json`. The existing integration loads the hub plugin with
  `--plugin-dir` (`packages/claude-code/src/wrapper.ts`).
- The only config hub edits is its own `config:hub/claude-code.json`, and only the key `/binary`. The edit is
  lossless and pinned by a precondition. A rollback removes the file, or restores it if it existed before.
- Logins are user-mediated (`claude auth login`). `provider-auth` runs `claude auth status`, reads only its exit
  code and `authMethod`, and drops the rest of the output. The child gets the user's environment minus `HUB_*` and
  `BUN_BE_BUN`. `version-exec` gets only `PATH`, `HOME` and the update switches.

## Pin template for `release/harness-pins.json` (fill in from a fresh re-download; never copy digests from here)

```json
{ "pin": { "harness": "claude-code", "version": "<exact, e.g. the stable channel's>", "target": "darwin-arm64",
           "url": "https://downloads.claude.ai/claude-code-releases/<version>/darwin-arm64/claude",
           "file": "claude", "size": <bytes>, "sha256": "sha256:<hex of the re-downloaded file>",
           "evidence": ["gpg-manifest", "macos-notarization"], "minimumVersion": "2.1.89" },
  "review": { "by": "<handle>", "on": "<date>", "checked": ["upstream-release", "digest-redownloaded", "evidence-listed"] } }
```

- Pins for `linux-x64` and `linux-arm64` list `"evidence": ["gpg-manifest"]`. Linux binaries are not codesigned.
- `minimumVersion` 2.1.89 is the first release with a signed manifest.
- `file` must be `claude`, upstream's raw binary. The `.zst` variant is refused by `unpack`.
