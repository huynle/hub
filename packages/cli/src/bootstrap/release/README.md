# Standalone hubctl releases

This directory builds, signs and verifies the standalone `hubctl` (contracts §3.6, §3.7, I5, I6 in
`docs/bootstrap-contracts.md`). The central hub server binaries (`scripts/build-binaries.sh`) are separate and
unchanged.

| File | Role |
|---|---|
| `verify.ts` | The installer's checks on a downloaded hubctl: signature (trust root), exact target, size and digest, downgrade policy. |
| `manifest.ts` | Builds the manifest body (every supported target, or an explicit `targets` subset; matrix order; harness pins) and signs it (ed25519, detached, over `manifestPayload`). |
| `pins.ts` | The reviewed harness pin list (`harness-pins.json`): format, validation, re-download check. |
| `trust-root.ts` | The trust root embedded at build time (`--define HUBCTL_TRUST_ROOT=…`), never read at run time. |
| `assets.ts` | The six service templates of `EMBEDDED_ASSETS`, imported as text so the binary carries them. |
| `cli.ts` | The release tool behind `bun scripts/hubctl-release.ts build\|manifest\|sign\|verify\|trust-root`. |

Everything except `build` needs only bun and node's built-ins, so the signing job installs no npm packages.

## Building

```sh
scripts/build-hubctl.sh                        # dev build: every supported target, no trust root
scripts/build-hubctl.sh linux-x64              # one target
scripts/build-hubctl.sh --require-trust-root   # release build: refuses without trust-root.json
scripts/build-hubctl.sh linux-x64 --outdir /tmp/out   # binaries and checksums in /tmp/out
```

Outputs: `dist/hubctl-<target>` and `dist/HUBCTL_SHA256SUMS` (in `--outdir` instead, when given). x64 targets are
compiled against Bun's `-baseline` runtime, which needs no AVX2 (older CPUs, QEMU's default `kvm64` model). The supported targets are `darwin-arm64`,
`darwin-x64`, `linux-x64` and `linux-arm64` (glibc). Windows and musl are refused with their reasons. The
binary is the whole program: it runs without bun, node or the repository, and a `hub` link to it is the same
command surface. A build without a trust root cannot verify any release (`shippedTrustRoot` fails closed).

## The harness pin list (`harness-pins.json`)

```json
{ "schema": "hub.harness-pin-list", "version": 1,
  "pins": [ { "pin": { "harness": "opencode", "version": "…", "target": "darwin-arm64", "url": "https://…/file.zip",
                       "file": "file.zip", "size": 123, "sha256": "sha256:…", "evidence": [] },
              "review": { "by": "github-handle", "on": "2026-10-28",
                          "checked": ["upstream-release", "digest-redownloaded", "evidence-listed"] } } ] }
```

`pin` is exactly a manifest `HarnessPin`. Each pin is checked with the manifest's own rules: a supported
target, an exact version, https, a plain file name, one pin per harness and target, and only evidence that
harness can offer. On top of that, the file must be the URL's last path segment, the URL may not carry
credentials, a query or a fragment, and nothing secret-shaped may appear anywhere in the list.

The list is empty until the harness adapter tasks confirm the upstream sources (HBS-06 for OpenCode 2.x).

**Review process**

1. A pin changes only through a pull request that touches `harness-pins.json`. The reviewer is not the author.
2. The reviewer fills in `review`:
   - `by`: their GitHub handle.
   - `on`: the review date.
   - `checked`: all three checks.
     - `upstream-release`: the URL is the upstream's own release asset for exactly this version and target.
     - `digest-redownloaded`: they downloaded the file themselves and computed its size and sha256, for example
       with `curl -fsSL <url> | shasum -a 256`.
     - `evidence-listed`: `evidence` lists exactly the upstream evidence published for that file (§5 of the
       contracts doc).
3. CI validates the file (`bootstrap-release-pins.test.ts`).
4. At release time, the `hubctl-sign` job downloads every pinned file again and refuses to sign on any size or
   digest mismatch. The signature never vouches for a file that nobody fetched during that release.

## The release key (decision Q5)

There is one ed25519 key, with threshold 1. The private key is the `HUB_RELEASE_SIGNING_KEY` secret of the
`hubctl-release` GitHub environment. Only the `hubctl-sign` job uses that environment, and only its Sign step
sees the secret. The key is PKCS#8, either PEM or base64 DER. No key is ever committed.

A maintainer sets the key up once, on their own machine. This has not been done yet:

```sh
openssl genpkey -algorithm ed25519 -out release-key.pem      # keep it offline
HUB_RELEASE_SIGNING_KEY="$(cat release-key.pem)" bun scripts/hubctl-release.ts trust-root --key-id hub-release-1 \
  > packages/cli/src/bootstrap/release/trust-root.json       # public key only; commit through a reviewed PR
gh secret set HUB_RELEASE_SIGNING_KEY --env hubctl-release < release-key.pem
gh variable set HUBCTL_RELEASE --body true                   # enables the hubctl release jobs
gh variable set HUBCTL_MINIMUM_VERSION --body 0.0.0           # the security floor (optional, default 0.0.0)
```

To rotate the key, publish a version-2 trust root signed by the current key (`rotateTrustRoot`), with the old key
`retired`, or `revoked` if it was compromised. Then update `trust-root.json` and the secret.

## The release workflow (`.github/workflows/release.yml`)

The hubctl jobs are added alongside the existing jobs. They run only when `HUBCTL_RELEASE` is `true`.

1. `hubctl` (needs `test`): `scripts/build-hubctl.sh --require-trust-root` cross-compiles all four targets.
   Then it smoke-tests `linux-x64` with an empty `PATH` (no bun or node): `--version` must equal the CLI
   version, and `hub --help` must equal `hubctl --help`.
2. `hubctl-sign` (needs `hubctl`, environment `hubctl-release`, no npm install):
   - `manifest` re-downloads the pins and writes the body. `issuedAt` is the tagged commit's time.
   - `sign` signs the body and verifies it against `trust-root.json`. A wrong secret writes nothing.
   - `verify --dist dist` runs the installer's checks on every artifact.
3. `hubctl-publish` (needs the existing `release` job and `hubctl-sign`): it verifies again, then attaches
   `hubctl-*`, `hubctl-manifest.json` and `HUBCTL_SHA256SUMS` to the GitHub release.

## Verifying by hand

```sh
bun scripts/hubctl-release.ts verify --manifest hubctl-manifest.json --target linux-x64 --file hubctl-linux-x64
```

The exit code is 0 when the artifact is accepted and 11 when it is rejected: `signature_invalid`, `wrong_platform`,
`integrity_mismatch`, `downgrade_rejected` or `below_security_floor`. Pass `--installed V --installed-sha256 D`,
`--floor V` and `--allow-downgrade` to apply the downgrade policy.

## A partial release (some targets only)

`manifest`, `sign` and `verify --dist` take `--targets T,…` (e.g. `--targets linux-x64`) to list exactly the
targets a test or partial release ships. Each listed target must be built and is checked in full; an artifact for
any other target is refused. `sign` refuses a partial body unless `--targets` names the same list, so a partial
release is never signed by accident. Without `--targets`, every supported target is required.
