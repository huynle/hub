# Bootstrap contracts (v1, amendments v1.1 and v1.2)

Status: **frozen v1** (amended on 2026-10-28, before any release, with the user's decisions on the open
questions: pinned harness installs, manual edits for symlinked configs, and release signing; see §8), then
**amendment v1.1** (2026-10-28, still before any release; `CONTRACT_AMENDMENT = "1.1"`), a coordinated change to the
contracts and every merged bootstrap module. Each v1.1 change is marked "v1.1" below, and §9 lists them all. Then
**amendment v1.2** (2026-10-29, `CONTRACT_AMENDMENT = "1.2"`, additive): readiness probes are classified, so a
fresh install that only waits on the user's login or spoke commits as "installed, not ready" (§10).
Code: `packages/cli/src/bootstrap/contracts/`. Tests: `packages/cli/test/bootstrap-contracts.test.ts`,
`packages/cli/test/bootstrap-contracts-v11.test.ts` and `packages/cli/test/bootstrap-contracts-v12.test.ts`. Shared
fixtures: `packages/cli/test/bootstrap/fixtures.ts`.

This document defines the contracts for bootstrapping a machine into Hub with a standalone `hubctl`, which is
installed before any harness and then installs pinned harnesses itself: the documents each layer exchanges, the rules that validate them, the threat model they
defend against, and the edits needed to integrate them into the CLI. It holds no implementation of discovery,
planning, applying or enrollment; later tasks build those on these contracts.

Changing a contract means a new schema version, plus a migration wherever documents persist (see `migrateProfile`).
The meaning of an existing version never changes in place. v1.1 follows this rule: the profile, the only
user-authored document that persists, becomes version 2, with a migration from version 1. The other v1.1 changes are
additive: new action kinds, codes, an enrollment state and a manual-edit reason. Every v1 document is still valid
v1.1, so their schema versions stay. A v1.0 hubctl refuses v1.1 additions as `invalid_value`/`unknown_field`, never
misreads them.

## 1. Shape of the bootstrap

- `hub` and `hubctl` are two names for **one command surface** (`COMMAND_ALIASES`, `commandSurface`). The program
  name never grants or removes authority. Only credentials, scopes and grants do.
- Canonical enrollment: `hubctl machine enroll` and `hubctl machine status`. They work without any harness and
  reuse the device-code flow in `packages/spoke-sdk/src/enroll.ts` (`POST /spoke/enroll`, `/spoke/enroll/poll`).
  `hubctl setup` calls the same implementation. Every spoke and `hub node` on the machine shares one machine
  identity.
- Flow: **discover → deterministic preview → explicit local apply** (or render the *same* plan as Ansible) **→
  device-code enrollment → real harness/provider verification → optional bounded launch**.
- hubctl **installs pinned harnesses** (OpenCode first, then Claude Code, then Codex) from artifacts whose exact
  version, platform, source and sha256 are pinned in hub's own signed release manifest (§3.6.1). An installed
  harness is not a ready one: every install is followed by real verification. Provider and interactive harness
  logins stay with the user, on the machine.
- Harness order: OpenCode, then Claude Code, then Codex (`HARNESS_ORDER`). OpenShell is opt-in, for discovery and
  verification only (`RUNTIME_IDS`, action `verify-runtime`). The bootstrap never installs or configures it.
- Profiles: `session-only`, `launch-node`, `full-harness` (`profile.ts`).
- Hub Central and the node protocol gain no shell, SSH or remote-exec capability. Every step is a typed local
  operation done by the local `hubctl`. The default is unprivileged; escalation and service activation are always
  explicit.

## 2. Module map

| Module | Contract |
|---|---|
| `validate.ts` | `Result`/`Issue` (with JSON-pointer paths and machine-readable `IssueCode`s), strict-shape helpers. No dependencies. |
| `canonical.ts` | `canonicalJSON` (sorted keys, no `undefined`, refuses NaN/∞/non-plain objects), `digestOf` (`sha256:<hex>`), `hostFingerprint`. |
| `secrets.ts` | `findSecrets`: credential-named keys and credential-shaped values (`hat_`, `hst1.`, `hlt1`, `mt_`, `sk-`, GitHub/Slack tokens, PEM private keys, `Bearer`). |
| `platform.ts` | `SUPPORTED_TARGETS`, `UNSUPPORTED_TARGETS` (with reasons), `targetOf`, `checkTarget`. |
| `paths.ts` | `PathRef` (named root + safe relative path), `resolvePathRef`, `checkNoSymlinkEscape`, `ELEVATED_ROOTS`. v1.1: `ExecutionContext`, `rootPathIn`, and a context argument for `resolvePathRef`. |
| `exec.ts` | Executable/argv contract: `programLayout`, `serviceArgv`, `SERVICE_COMMANDS`, `EMBEDDED_ASSETS`. |
| `harness.ts` | `HarnessAdapter` (discover/plan/verify), `Probe`, `REQUIRED_PROBES`, `isHarnessReady`, `createAdapterRegistry`, `EVIDENCE_KINDS`, `HARNESS_EVIDENCE`. v1.2: `PROBE_CLASS` (`integrity` / `user`), `harnessReadiness` (`ready` / `pending` / `failed`, per-probe status, next steps), `PENDING_STEPS`. |
| `actions.ts` | Typed `Action` union (16 kinds; v1.1 adds `select-harness-version`, `deactivate-service` and `remove-service`), `ACTION_FIELDS`/`ACTION_OPTIONAL`, `EXEC_KEYS`, `validateAction`. v1.1: `harnessVersionRef` and `harnessCurrentRef`. |
| `discovery.ts` | `DiscoverySnapshot`, `validateDiscoverySnapshot`. v1.1: `snapshotDigest`, `executionContextOf`. |
| `profile.ts` | `Profile` (v1.1: version 2, with `revision?` and `enrollment?`), `validateProfile`, `migrateProfile` + `PROFILE_MIGRATIONS` (1 → 2), `ENROLLMENT_MODES`, `enrollmentModeOf`, `PLAN_PROFILE_VERSIONS`. |
| `plan.ts` | `SetupPlan`, `planDigest`, `PreviewToken`, `revalidatePreview`. |
| `preview.ts` | `SetupPreview` (the plan output), `ManualEdit` blocker (v1.1: `MANUAL_EDIT_REASONS`), `manualEditFor`, `unmergeableEditFor` (v1.1), `previewApplicable`. |
| `artifact.ts` | `ArtifactManifest` (+ `HarnessPin`s), `VerifiedManifest`, `TrustRoot`, `verifyManifest`, `rotateTrustRoot`, `selectArtifact`, `checkArtifactBytes`, `compareVersions`, `decideInstall`, `checkHarnessPin`, `checkHarnessEvidence`, `decideHarnessInstall`. |
| `credentials.ts` | `CredentialStore`, `MachineEnrollment`, `MachineCredential`, secret-free `EnrollmentStatus` (v1.1: the `insecure` state), `enrollmentStatusFrom`. |
| `journal.ts` | `TransactionJournal`, `JournalEntry` (ownership records), `recoveryDecision`/`recoveryPlan`, `JournalHooks`, `ApplyLock`, `lockState`. |
| `envelope.ts` | `ResultEnvelope` (`--json`), `ERROR_CODES`, `BOOTSTRAP_EXIT`, `exitFor`. |

Every validator takes `unknown`, rejects unknown fields, and returns **all** issues. Each issue has a stable `code`:
callers and tests match on the code, never on the message.

## 3. Contracts

### 3.1 Supported platform matrix

| Target | Platform | Arch | libc | Services | Bun build target |
|---|---|---|---|---|---|
| `darwin-arm64` | macOS | arm64 | — | launchd (user agent) | `bun-darwin-arm64` |
| `darwin-x64` | macOS | x64 | — | launchd (user agent) | `bun-darwin-x64-baseline` |
| `linux-x64` | Linux | x64 | glibc | systemd `--user` | `bun-linux-x64-baseline` |
| `linux-arm64` | Linux | arm64 | glibc | systemd `--user` | `bun-linux-arm64` |

The x64 targets build against Bun's `-baseline` runtime. The default x64 runtime requires AVX2 and dies with
`SIGILL` (exit 132) on CPUs without it, before hubctl can print `--version`: older Intel/AMD hosts and QEMU guests
with the default `kvm64`/`qemu64` CPU model. The artifact names stay `hubctl-<target>`. Harness pins for x64 targets
should likewise use the upstream baseline builds where one is published (for OpenCode,
`opencode-<os>-x64-baseline.*`; see `packages/cli/src/bootstrap/adapters/opencode/README.md`).

Explicitly unsupported, with the reason reported: `windows-x64`, `windows-arm64` (Windows bootstrap is out of
scope), `linux-x64-musl`, `linux-arm64-musl` (no musl build). Any other target fails with `unsupported_platform`.
A discovery snapshot can *describe* an unsupported host (`supported: false`), but no plan can target one.

### 3.2 DiscoverySnapshot (`hub.discovery-snapshot` v1)

A read-only description of the host: platform/arch/libc/target (with `supported` exactly matching the matrix), OS,
container kind and shims (`host` / `container-shim` / `wrapper`, with `resolvesTo`), package, runtime and service
managers, harnesses, OpenShell presence, the config files the plan might touch (owner, format, digest — never
contents), and root mappings (`home`, `config`, `state`, `data`, `user-bin`, `launch-agents`, `systemd-user`,
`system-bin`, each with an optional `containerPath`).

**v1.1 container roots.** A root's `path` is always the **host's** view of it. `containerPath` is what a process
inside the container sees. Discovery records `containerPath` only when it runs inside a container whose mount table
maps the root to a host directory. Code resolves a path for the **execution context** it runs in (`ExecutionContext`:
`host` | `container`):

| Context | A root resolves to |
|---|---|
| `host` (default) | `path` |
| `container` (hubctl runs inside the container) | `containerPath ?? path` |

`rootPathIn(root, context)` and `resolvePathRef(ref, roots, context)` are the only implementations. The context of
a plan is the one discovery ran in, `executionContextOf(snapshot)`: `container` unless `topology.container` is `none`.
Discovery, link inspection, manual-edit paths and the applier all use it.

**v1.1 snapshot digest.** `snapshotDigest(snapshot)` is `digestOf` of the snapshot with `capturedAt` removed, so
rediscovering an unchanged host gives the same digest. It is the only digest plans, preview tokens, audits, apply
revalidation and the Ansible vars pin for a snapshot (§3.4).

Discovery reports a harness reached through `data:hub/harnesses/<harness>/current` (§3.6.1) as
`installMethod: "hub"`, with the version of the directory the link resolves to (v1.1). It also finds such a harness
when it is not on PATH (`current/bin/opencode`, `current/claude`, `current/bin/codex`; PATH still wins), so a
preview after an install plans no second install (HBS-13). hub's own `config:hub/claude-code.json` is a config
candidate, so the Claude Code adapter's merge is pinned to the discovered digest.

Harness entries keep **presence apart from health**. `installed: true` means the harness was found. Its
`health.state` stays `unverified` until probes run. `verified` requires at least one passing non-`presence` probe
and no failing ones. A harness that is not installed has no path, version or verified health.

### 3.3 Actions (typed, closed union)

- `ensure-directory`
- `install-artifact`: hubctl only.
- `install-harness`: a pinned harness artifact (§3.6.1). v1.1: into exactly `harnessVersionRef(harness, version)`.
- `select-harness-version` (v1.1): `{harness, version, path, target, previous?}`. It switches the `current` link
  `path` = `harnessCurrentRef(harness)` atomically to `target` = `harnessVersionRef(harness, version)` (`inconsistent`
  otherwise). Journal class `link`: the previous link is backed up, so a rollback makes the previous version current
  again.
- `link-executable`: the hub ↔ hubctl alias, and (HBS-12, A6) a hub-installed harness's PATH link in `user-bin`
  (§7.6). Its `target` is only the link's text: it is a checked PathRef, but not symlink-checked, since a harness's
  `current` is a link by design.
- `write-file`: an embedded or rendered asset pinned by digest, `onConflict: "refuse"` only.
- `merge-config`: lossless (`preserveUnknown: true` only, precondition digest, JSON-pointer sets). v1.1: `json` and
  `jsonc` files may have comments and trailing commas, and are edited in place without losing either (§3.12.1).
  `toml` is never merged; the planner turns it into an `unmergeable-format` manual edit (§3.12).
- `register-mcp-server`: registers *this* hubctl's `mcp` subcommand and never carries a command.
- `install-service`: an embedded template for that service and manager, in that manager's root.
- `activate-service`: `confirm: "explicit"` only.
- `deactivate-service` (v1.1): `{service, manager}`. It unloads a hub service when a profile downgrade removes it
  (`--allow-downgrade`). An external effect whose undo loads the service again.
- `remove-service` (v1.1): `{service, manager, path, sha256}`. It removes the unit in that manager's root, only
  while it is exactly the unit hub installed (`sha256`); a changed unit is a conflict. Backed up, so a rollback
  restores it.
- `enroll-machine`: server URL + machine name, never a credential.
- `verify-harness`: real probes only.
- `verify-runtime`: OpenShell, opt-in.
- `launch-session`: bounded, 1 s to 24 h.

There is **no generic "run command" action**, and no action has a field that could carry one:

- `ACTION_FIELDS` lists every accepted field, and none matches `EXEC_KEYS` (`command`, `cmd`, `shell`, `script`,
  `exec`, `argv`, `args`, `run`, `eval`, `sh`, `bash`, `program`, `spawn`, `hook(s)`, …).
- A command-shaped key **anywhere** in an action, at any depth (including inside `merge-config` values), is rejected
  with `exec_field`. Unknown fields are `unknown_field`. Unknown kinds are `invalid_value`.
- The type system enforces the same rule: a compile-time assertion in the tests checks that no key of any `Action`
  variant is in `EXEC_KEYS`.

Escalation is exact. An action is `elevated` if and only if it touches an elevated root (`system-bin`). Every other
root is the user's own.

All paths are `PathRef`s. `rel` is non-empty and relative. It may not contain `..` or `.` segments, empty segments,
a leading `/`, backslashes or control characters. The applier resolves it against the discovered root and refuses
to write through **any symlink** between the root and the target (`checkNoSymlinkEscape`). For configs this has a
defined outcome: the planner replaces the action with a `ManualEdit` blocker (§3.12).

### 3.4 SetupPlan (`hub.setup-plan` v1) and preview

A plan is a pure function of (snapshot, profile). It has no timestamps and no randomness, so `planDigest` (the
digest of its canonical JSON) is deterministic. It records `hostFingerprint`, `snapshotDigest` (v1.1: always
`snapshotDigest(snapshot)` from §3.2, which excludes `capturedAt`), `target`, `profile {id, version}` (v1.1: profile
version 1 or 2, so a plan journaled by a v1.0 hubctl still resumes), the actions in execution order, and two flags
that must be exactly right: `requiresEscalation` (some action is elevated) and `activatesServices` (some action
activates a service).

Order rules:

- A service is installed before it is activated.
- A harness is verified before a session is launched on it.
- Every installed harness is verified later in the plan (install is not readiness).
- v1.1: an installed version is made current (`select-harness-version` of the same version) after it is installed
  and before the harness is verified.
- v1.1: a service is deactivated before it is removed.
- The machine is enrolled at most once.
- At most 256 actions.

**v1.1 enrollment mode.** Plans either enroll inline or leave enrollment to `hubctl machine enroll` (`enrollment:
"inline" | "separate"`). The mode comes from the planner option, else the profile's `enrollment`, else `inline`.
`separate` leaves out every `enroll-machine` action. So a direct preview with `separate` and the Ansible path (whose
rendered profile is always `separate`, §3.13) plan the same actions and the same digest. Apply must re-plan with the
same mode, or the digests differ (`preview_stale`).

`PreviewToken` (`hub.preview-token` v1) holds `{planDigest, hostFingerprint, snapshotDigest, issuedAt, expiresAt,
nonce}`, with a lifetime of at most 15 minutes and a nonce of 16–128 url-safe characters.

**Revalidation rules (`revalidatePreview`), checked in this order at apply time:**

1. The token is well formed (`invalid_value`).
2. Its host fingerprint and the fresh plan's both equal the fingerprint computed **now** (`preview_foreign`).
3. `now < expiresAt` (`preview_expired`).
4. `issuedAt ≤ now + 60 s` (`preview_not_yet_valid`).
5. The nonce is not in any earlier journal (`preview_replayed`).
6. Apply **rediscovers and re-plans**. The fresh snapshot digest and the fresh plan digest must both equal the
   token's (`preview_stale`).

A refused apply writes nothing, not even the applier's state directories under `state:hub/bootstrap`: the engine
runs these checks (and the consent checks) once before it takes the apply lock, and again under the lock.

The token is not an authority: apply only compares it against values it just computed itself. A forged token can
at most cause a plan the user could have previewed anyway to be applied, and even then only on this host and only
if nothing changed. For this reason the token is deliberately unsigned and has no MAC (decision Q6).

### 3.5 Profile (`hub.bootstrap-profile` v1)

`{id, harnesses (in HARNESS_ORDER), runtimes, services, launch {enabled, maxDurationS}, escalation: never|explicit,
revision?, enrollment?}`. **v1.1: profile version 2.**

- `revision` is the built-in catalog revision the profile was made from (an integer ≥ 1). Catalog profiles always
  carry it. `rebaseProfile` uses it to find the defaults a profile was made from, refuses an explicit base of another
  revision (`inconsistent`) and a move to an older revision (`downgrade_rejected`), and records the new revision.
- `enrollment` is `inline` (default) or `separate` (§3.4).
- `PROFILE_MIGRATIONS[1]` upgrades a version-1 document by setting `version: 2`. The new fields are optional and mean
  what version 1 meant: unknown revision, inline enrollment.

`session-only` has no services and no launch. `launch-node` and `full-harness` need the `node` service. Launching
needs `node` and a bound duration. A spoke service needs its harness (`claude-code` → `claude-code`, `codex` →
`codex-spoke`). `migrateProfile(raw, migrations)` upgrades a document one version at a time through
`PROFILE_MIGRATIONS[version]`. It refuses versions it cannot migrate (`unmigratable`) and versions newer than this
hubctl (`unsupported_version`).

### 3.6 ArtifactManifest (`hub.artifact-manifest` v1) and TrustRoot

- The manifest has `{product: "hubctl", release (semver), channel, minimumVersion (security floor ≤ release),
  issuedAt, artifacts[{target, file (plain name), size, sha256}], signatures[{keyID, algorithm: "ed25519",
  value}]}`. Each artifact target is a supported target, listed once.
- Signatures are detached ed25519 signatures over `manifestPayload` (the canonical JSON without `signatures`).
  `threshold` **distinct active** keys of the trust root must sign. Unknown, retired and revoked keys never count.
- The trust root is `hub.trust-root`, with `{version, threshold, keys[{keyID, ed25519 SPKI publicKey, status}]}`.
  It ships inside hubctl. Rotation (`rotateTrustRoot`) only moves forward: the new root must have a higher
  version (else `trust_root_rollback`) and be signed by `threshold` active keys of the *current* root.
- The installer selects the host's **exact** target (`selectArtifact`, else `wrong_platform`) and checks the
  downloaded bytes' size and digest (`checkArtifactBytes`, else `integrity_mismatch`).
- Downgrade policy (`decideInstall`):
  - Nothing installs below the security floor, which is the maximum of the manifest's `minimumVersion` and the
    highest floor this machine has seen (`below_security_floor`).
  - An older release needs explicit `--allow-downgrade` (`downgrade_rejected`).
  - The same version with different bytes is tampering (`integrity_mismatch`).
- `verifyManifest` returns a `VerifiedManifest`, a branded type only it produces. Functions that trust pins
  (`checkHarnessPin`) accept only a `VerifiedManifest`, so an unverified manifest cannot be used by mistake.
- Release signing (decision Q5): **one ed25519 key**, threshold 1. The private key is a GitHub Actions secret
  that only the release workflow can read. The public key is embedded in hubctl's trust root. Forward-only
  rotation (`rotateTrustRoot`) stays: replacing the key means publishing a version-2 root signed by the current
  key, with the old key `retired`, or `revoked` if it was compromised.

#### 3.6.1 Pinned harness artifacts (transitive trust)

- The hub manifest also lists `harnesses[{harness, version (exact), target, url (https), file, size, sha256,
  evidence[], minimumVersion?}]`, at most one per harness and target. The pins are part of the signed payload, so
  hub's release signature vouches for each upstream file. That is how an upstream publishing no signature at all
  (OpenCode) becomes installable: only its digest pinned by hub vouches for it.
- `install-harness` has `{harness, version, target, source {manifest (the hub release), url, file}, size, sha256,
  evidence[], path (the install root: a named root + relative path), owner: "hub", rollback: "restore-previous",
  previous? {version, sha256}}`. No field can carry a command: there is no installer script and no post-install
  hook. The applier downloads the pinned file, checks it, and unpacks it into `path`.
- `checkHarnessPin(verifiedManifest, action)`:
  - The action must name that manifest's release, and a pin must exist for exactly this harness, target and
    version. Otherwise `unpinned_artifact`.
  - The source, size and digest must equal the pin's. Otherwise `integrity_mismatch`.
  - The action must attempt exactly the evidence the pin lists. Otherwise `inconsistent`.
- `checkHarnessEvidence(action, bytes, results)`:
  - The pinned sha256 is checked first and is **mandatory**. That guarantees the "never neither" rule.
  - The upstream evidence kinds (`HARNESS_EVIDENCE`) are optional and recorded as `verified` or `unavailable`.
    A `failed` check rejects the artifact (`evidence_failed`). A check nobody planned is refused.

  | Harness | Mandatory | Optional evidence (recorded, never required) |
  |---|---|---|
  | OpenCode | sha256 pinned in hub's signed manifest | none |
  | Claude Code | sha256 pinned in hub's signed manifest | upstream GPG-signed `manifest.json` (`gpg-manifest`), macOS notarization (`macos-notarization`); no hard `gpg` dependency |
  | Codex | sha256 pinned in hub's signed manifest | sigstore bundle where upstream publishes one (`sigstore`); macOS notarization (`macos-notarization`, allowed since HBS-13; the Codex source does not check it yet, so pins must not list it) |
- `decideHarnessInstall(pin, {installed, floor, allowDowngrade})` applies the same downgrade policy as hubctl,
  with the pin's `minimumVersion` as the harness floor.
- Rollback (v1.1 layout): each version is installed once into its own immutable directory
  `data:hub/harnesses/<harness>/<version>`, so an install creates a fresh `harness` entry, which recovery removes
  (`remove-created`). `data:hub/harnesses/<harness>/current` is a relative symlink that `select-harness-version`
  switches. It is journal class `link` and is backed up, so recovery restores the previous link (`restore-backup`):
  the previous version is current again. A v1.0 journal that installed into place is still recovered by the same
  rules.
- Discovery reports harnesses installed this way as `installMethod: "hub"`.

### 3.7 Executable and argv contract

- `programLayout({execPath, entry})`: an entry under Bun's embedded filesystem (`/$bunfs/…`) means a **standalone**
  binary (`{kind: "standalone", executable}`). Anything else is a **script** run by a runtime (`{kind: "script",
  runtime, entry}`; this covers the npm bundle, and OpenCode with `BUN_BE_BUN=1`).
- `serviceArgv(layout, service)` returns the absolute program words followed by `SERVICE_COMMANDS[service]` (`node
  run`, `claude-code daemon`, `codex-spoke serve`). This is always a word list, never a shell string. It throws on
  relative or multi-line paths.
- `EMBEDDED_ASSETS` lists the six service templates (three services × launchd/systemd) that a standalone binary
  carries inside itself instead of reading `scripts/` at run time.

### 3.8 Enrollment and credentials

`CredentialStore` (`read`/`write`/`clear`; atomic writes, mode 0600, lossless merge) is the **only** place the
machine token exists. `MachineEnrollment` is the device-code flow. `EnrollmentStatus` (`hub.enrollment-status`)
has no field that can carry a credential, and its validator also scans values for one. Its states are:

- `unconfigured`: no credential stored.
- `configured`: stored, not checked.
- `verified`: the hub accepted it, at `checkedAt`.
- `revoked`: the hub rejected it.
- `offline`: the hub could not be reached.
- `insecure` (v1.1): stored for a plain-http hub that is not on loopback. It is reported with a warning (`machine
  status` succeeds) and is **never probed**: the token is never sent over plain http. Only this state may name such
  a server, and it has no `checkedAt`. A **new** enrollment over plain http to a non-loopback hub stays refused
  (`usage`).

`enrollmentStatusFrom(credential, probe, now)` derives the state; it ignores any probe for an insecure hub.

v1.1 error codes: a denied device code is `enrollment_denied` (exit 5); an expired one, whether the hub or the
client's own deadline expired it, is `enrollment_expired` (exit 4); an aborted enrollment is `cancelled` (exit 4).
These are the exits those outcomes already had.

### 3.9 Transaction journal, ownership and lock

- The journal (`hub.transaction-journal`) records the plan digest, host fingerprint, consumed nonce, state, and one
  entry per change, numbered 1…n. Each entry has a class, a path, `before`/`after` file states (digest and mode
  only, **never contents**), a backup reference, and a status.
- Existing files of class file/config/service/artifact/harness/link are backed up before they change. Credentials are
  **never** backed up. v1.1: `validateJournal` exempts `status: "skipped"` entries (nothing changed, so there is
  nothing to back up).
- `recoveryDecision(entry, now)`:

  | Entry | File now | Decision |
  |---|---|---|
  | undone / skipped / external | any | `nothing-to-do` |
  | pending | equals `before` | `nothing-to-do` (never started) |
  | pending credential, no `after` (v1.1) | differs from `before` | `clear-credential` (the interrupted enrollment stored its credential; the store writes atomically) |
  | any | differs from `after` | `keep-user-edit` (reported as a conflict, never overwritten) |
  | credential | equals `after` | `clear-credential` (the stale previous credential is never restored) |
  | existed before | equals `after` | `restore-backup` |
  | created by us | equals `after` | `remove-created` |

  `recoveryPlan` applies these rules newest entry first. A finished transaction (committed or rolled back) needs
  no recovery.
- `JournalHooks` (`beforeAction`/`afterAction`/`onConflict`/`onRecover`) observe the journal and cannot change
  actions.
- The apply lock is `state:hub/bootstrap/apply.lock`, created with O_EXCL. It records the pid, host, transaction
  and expiry, and is held for at most 1 hour. `lockState` returns:
  - `free`
  - `held`: refuse with exit 13.
  - `stale`: same host, but the holder died or overran. Recover first, then take the lock.
  - `foreign`: another host's lock on a shared home. It is never broken automatically.

### 3.10 Harness adapters and readiness

A `HarnessAdapter` has `{id, discover(ctx), plan({snapshot, profile}) → Action[], verify(ctx) → probes}`. Adapters
are pure planners that work through injected context. They never get a shell. The registry accepts only known
harness IDs, once each, and lists them in `HARNESS_ORDER`. **Readiness (`isHarnessReady`) requires real probes:**
each of `REQUIRED_PROBES[harness]` (`version-exec`, `provider-auth`, `spoke-connected`) must be present, passing,
and observed within the last 15 minutes. `presence` never counts. Adapters must run `version-exec` against the binary the shim resolves to
(discovery's `resolvesTo`), not just the shim on PATH. That is an adapter obligation (HBS adapter tasks), which
`isHarnessReady` cannot check by itself.

v1.2: a probe that is not passing is classified by its kind (§10): an `integrity` failure means the install is
broken and apply rolls back; a `user` probe pending means the harness is installed, not ready, which apply commits
unless `--require-ready` is given. Readiness itself is unchanged: only `isHarnessReady` (every probe passing) makes a
harness ready, and nothing advertises a capability before that.

### 3.11 Output envelope and exit codes

With `--json`, stdout carries exactly one `hub.bootstrap.result` envelope:
`{command, ok, data?, error?: {code, message, hint?}, warnings?}`. `ok: true` has no error; `ok: false` always has
one. The validator rejects any envelope containing a secret. Since HBS-13 the one exception is `/data/token` when
`data` is a `hub.setup-preview` (the preview token is not a credential, §3.4); its values are still scanned.

Exit codes 0–9 are the CLI's existing codes (`http.ts` `EXIT`), unchanged. The bootstrap adds:

| Exit | Name | Codes |
|---|---|---|
| 10 | `conflict` | `conflict`, `manual_edit_required` |
| 11 | `artifactRejected` | `wrong_platform`, `integrity_mismatch`, `signature_invalid`, `downgrade_rejected`, `below_security_floor`, `trust_root_rollback`, `unpinned_artifact`, `evidence_failed` |
| 12 | `previewInvalid` | `preview_*` |
| 13 | `locked` | `locked` |
| 14 | `recoveryRequired` | `recovery_required` |
| 15 | `notReady` | `harness_not_ready` |

The other codes map to existing exits: `unsupported_platform`/`offline` → 7, `escalation_required`/`needs_user` →
4, `revoked`/`unauthorized` → 9, `usage`/`invalid` → 2, `not_found` → 3, `forbidden` → 5, `internal` → 1.
Exit codes 10–15 are approved (decision Q9).

v1.1 adds error codes for outcomes that already had an exit, so the exits do not change: `no_service_manager` → 7,
`enrollment_denied` → 5, `enrollment_expired` → 4, `cancelled` → 4. The planner's issue codes `escalation_required`
(an elevated action the profile never allows; it was `inconsistent`) and `no_service_manager` (the profile installs
services, but the host has no user service manager; it was `inconsistent`) are also error codes of the same name.

### 3.12 SetupPreview (`hub.setup-preview` v1) and manual edits

`hubctl setup preview` outputs `{plan, planDigest, token, blockers[], evidence[]}`. The validator checks that
`planDigest` is the plan's digest, and that the token is for this plan, host and snapshot.

- **Upstream evidence.** `evidence[]` reports, per `install-harness` action, each planned upstream check as
  `verified`, `unavailable`, `deferred` (it needs the downloaded bytes, so it runs at apply) or `failed`. Only
  checks the action planned may appear.
- **Manual edits (decision Q8).** A config behind a symlink is **refused**, for example `~/.config/opencode`
  linked into a dotfiles repository. The planner replaces the action with a `ManualEdit` blocker (`manualEditFor`):
  - It has `{reason: "symlinked-config", actionID, path, linkPath, resolvedPath, format?, owner?, precondition?,
    change}`.
  - v1.1: a second reason, `unmergeable-format`. A config hubctl cannot edit losslessly (TOML) gets the same exact,
    structured edit for the file itself (`unmergeableEditFor`, with `resolvedPath` in the execution context), and
    no bare conflict. It has no `linkPath`; `symlinked-config` requires one. At apply, a JSON/JSONC file that turns
    out to be unparseable (or has duplicate keys) is refused with `manual_edit_required` (exit 10) for the same
    reason.
  - `change` is the exact structured edit: `merge {set[]}`, `register-mcp-server {harness, name}` (the command is
    implied, as in the action) or `write-file {asset, sha256, mode}`.
  - It is validated like an action: no command-shaped keys, no secrets, absolute normalized paths.
  - The refused action is not kept in the plan. A preview that still contains it is `inconsistent`.
- **Apply gate.** `previewApplicable` refuses while any blocker remains (`manual_edit_required`, exit 10) or any
  evidence failed (`evidence_failed`, exit 11). Once the user has made the edit in their dotfiles, a new preview
  sees the changed config, so it has a new digest and no blocker.

#### 3.12.1 Lossless JSONC edits (v1.1)

OpenCode configs are often JSONC, and the plan must preserve the user's config structurally. `merge-config`
therefore never re-serializes a file:

- The applier parses JSON/JSONC (comments, trailing commas; duplicate keys are refused) into a syntax tree with the
  offsets of every value. It decides the change on the plain value with the same pointer rules as before: `-`
  appends unless the value is already there, missing containers are created, and a scalar in the way is a
  conflict.
- It then splices only the text of the value it replaces, or the member or item it inserts. Inserts use the
  container's indentation, comma style and separator, and never separate a value from its same-line comment.
- Every other byte stays as it was: comments, trailing commas, order, whitespace, and numbers and strings exactly as
  written. A merge that changes nothing returns the bytes unchanged.
- The result is parsed again and must equal the intended value, otherwise the merge is refused with
  `manual_edit_required`.
- Implemented in-house (`transaction/json-merge.ts`, `parseJsonc`, `mergeConfigText`), with no dependency.

### 3.13 Ansible vars (v1.1 notes)

The renderer (`ansible/render.ts`) always renders the profile with `enrollment: "separate"`, so hubctl plans without
`enroll-machine` on the host and the role's plan digest equals the direct path's. It still refuses a plan that
enrolls. When given the snapshot a plan was made from, it checks `snapshotDigest(snapshot) === plan.snapshotDigest`
(else `preview_stale`).

## 4. Threat model

Assets: the machine credential, the user's harness configs and dotfiles, the integrity of the installed `hubctl`,
and the user's account (no unintended privilege or persistence). Adversaries: a network or mirror attacker serving
release files; a local process or a planted symlink in the user's directories; a stale or copied preview; a
concurrent or crashed `apply`; a compromised or buggy Hub Central trying to make machines execute things; and
careless logging.

| # | Threat | Mitigation (contract) | Acceptance check (tests in `bootstrap-contracts.test.ts`) |
|---|---|---|---|
| T1 | Tampered artifact or manifest | ed25519-signed manifest with a threshold of active trust-root keys; size + sha256 of the bytes checked; same version with other bytes refused | `ArtifactManifest > rejects a tampered manifest`, `checkArtifactBytes refuses…`, `the same version with different bytes is tampering` |
| T2 | Unknown, revoked or rotated-out signing key | Only active keys of the shipped trust root count; forward-only, current-root-signed rotation | `rejects unsigned manifests, unknown keys and revoked keys`, `counts distinct trusted keys…`, `trust root rotation > …` |
| T3 | Wrong-platform artifact | Exact target selection; manifests may only list supported targets | `selectArtifact pins the host's target…`, `ArtifactManifest rejects threat cases > windowsTarget` |
| T4 | Downgrade or rollback attack | Security floor (manifest + highest seen), explicit `--allow-downgrade`, trust-root version monotonic | `versions and downgrades > …`, `rejects rollbacks…` |
| T5 | Stale, foreign, expired or replayed preview | Preview bound to host fingerprint + snapshot digest + plan digest + 15-minute expiry + single-use nonce; apply re-plans and compares | `PreviewToken > rejects foreign, expired, early, replayed and stale previews`, `PreviewToken rejects threat cases` |
| T6 | Symlink / path traversal | `PathRef` (no `..`, absolute, `\`, NUL); unmapped roots refused; no writing through symlinks | `path references > …`, `Action rejects threat cases > traversal / absoluteRel / backslashRel / nulInPath / unknownRoot`, `TransactionJournal rejects threat cases > traversal` |
| T7 | Concurrent apply | O_EXCL apply lock; `held` refuses; another host's lock is never broken | `ApplyLock > …` |
| T8 | Crash mid-apply | Journal written before each action; recovery decides per entry from on-disk state | `TransactionJournal > a pending entry interrupted mid-write…`, `recoveryPlan walks entries newest first…` |
| T9 | Secret leakage (plans, journals, logs, status, Ansible) | No credential field in any contract except `MachineCredential`; `findSecrets` scan in every validator; journals record digests only; credentials never backed up | `findSecrets > …`, `…secretInConfig / secretValueInConfig / credentialInEnroll`, `EnrollmentStatus rejects threat cases`, `JOURNAL_INVALID contentInJournal / secretInJournal`, `ENVELOPE_INVALID leakedToken`, `DISCOVERY_INVALID secretInSnapshot` |
| T10 | Conflicting user edits / lossy config rewrite | `write-file` refuses conflicts; `merge-config` is lossless with a digest precondition; recovery keeps user edits; v1.1: JSONC is edited in place (comments, trailing commas, formatting kept), formats that cannot be edited that way become manual edits | `Action rejects threat cases > silentOverwrite / lossyMerge`, `an intervening user edit is never overwritten`, `mergeConfigText on JSONC > …` (`bootstrap-transaction-jsonc.test.ts`), `v1.1 unmergeable-format manual edits > …` |
| T11 | Stale credential restored on rollback | Credential entries are cleared, never restored from a backup | `a stale credential is never restored`, `JOURNAL_INVALID credentialBackup` |
| T12 | Central (or a plan) asking for command execution | No command-capable action kind or field, at any depth or in the types; `register-mcp-server` implies its command | `Action union > no action kind declares…`, `…accepts a smuggled command…`, `the type system has no command-shaped field either`, `runCommandKind / shellKind / nestedCommandInConfig` |
| T13 | Silent privilege escalation / persistence | `escalation` exact per action; plan flags `requiresEscalation` and `activatesServices` must be exact; activation needs `confirm: "explicit"`; v1.1: the planner refuses escalation a profile never allows with `escalation_required`, and a downgrade removes a component's persistence through typed `deactivate-service`/`remove-service` (consent still required) | `systemPathWithoutEscalation / needlessEscalation / implicitActivation`, `PLAN_INVALID hiddenEscalation / hiddenActivation`, `v1.1 planner codes > …`, `v1.1 downgrades plan typed service removal > …` |
| T14 | "Installed" mistaken for healthy (incl. container shims) | Presence ≠ health; readiness needs fresh, passing real probes | `harness readiness and adapters > …`, `DISCOVERY_INVALID verifiedWithoutProbes / verifiedByPresenceOnly` |
| T15 | Unsupported host half-configured | Explicit matrix; plans for unsupported targets refused | `supported platform matrix > …`, `PLAN_INVALID unsupportedTarget` |
| T16 | Executable name used as authority | `hub` / `hubctl` resolve to one surface | `executable argv contract > hub and hubctl are one command surface` |
| T17 | Shell injection through service units | argv word lists with absolute, single-line paths; embedded templates | `service argv is a word list, never a shell string` |
| T18 | Profile from a newer hubctl misread | Versioned profile; future versions refused; migrations explicit | `migrateProfile refuses…` |
| T19 | Unpinned or mismatched harness artifact (substituted URL, other version, other bytes, other hub release, unsupported target) | Harness pins in hub's **signed** manifest (transitive trust); `checkHarnessPin` needs a `VerifiedManifest`; exact version/target/source/size/sha256; mandatory digest check of the bytes | `harness pins in the signed hub manifest > …` (`unpinnedTarget`, `unpinnedVersion`, `otherHubRelease` → `unpinned_artifact`; `digestMismatch`, `sourceMismatch` → `integrity_mismatch`; tampered pin → `signature_invalid`), `the pinned digest is always checked first (never neither)` |
| T20 | Upstream evidence failing or skipped (bad GPG signature, failed notarization or sigstore) | A failed check rejects the artifact; evidence the pin lists must be attempted; the outcome is recorded in the preview and the install report | `failed evidence rejects the artifact…`, `HARNESS_PIN_INVALID evidenceSkipped`, `SetupPreview > failed evidence blocks apply` |
| T21 | Harness installer used as an exec channel (install scripts, post-install hooks) | `install-harness` has no installer/script/hook field; https only; plain file names | `install-harness rejects threat cases > installerScript / plainHttp / pathInFile`, smuggled-command tests (cover all 16 kinds) |
| T22 | Harness downgrade or failed install leaving a broken harness | Pin `minimumVersion` floor + explicit downgrade consent; v1.1: immutable version directories and an atomically switched, backed-up `current` link; rollback makes the previous version current again and removes only the new directory | `harness downgrade policy > …`, `harness rollback > …`, `v1.1 harness layout > …`, `v1.1 select-harness-version > …`, `PLAN_HARNESS_INVALID installWithoutSelect / selectBeforeInstall / verifyBeforeSelect` |
| T23 | Writing through a symlinked config into another repository | Refused; replaced by a structured, secret-free `ManualEdit`; apply blocked until resolved | `manual edits for symlinked configs > …`, `ManualEdit rejects threat cases`, `SetupPreview > a symlinked config blocks apply…` |
| T24 (v1.1) | Writing to the wrong directory from inside a container (host path vs container path confusion) | `path` is the host's view, `containerPath` the container's; one resolver for the execution context (`rootPathIn`), used by discovery, links, manual edits and apply | `v1.1 container roots > …`, `v1.1 execution context > …` (`bootstrap-transaction-v11.test.ts`) |
| T25 (v1.1) | A stored credential sent to a plain-http hub on the network | `insecure` status: reported with a warning, never probed; new plain-http, non-loopback enrollments refused | `v1.1 codes > an existing credential for a plain-http, non-loopback hub is insecure…`, `EnrollmentStatus rejects threat cases > verifiedOverPlainHttp / insecureHttps / insecureChecked`, `v1.1 insecure stored credentials > …` |
| T26 (v1.1) | A stale preview applied because a re-discovery's capture time hid a change, or a change hid behind it | One canonical `snapshotDigest` (excluding only `capturedAt`) everywhere; apply compares a fresh snapshot against the plan when given | `v1.1 snapshotDigest > …`, `v1.1 snapshot digest at apply > …`, `v1.1 canonical snapshot digest > …` |
| T27 (v1.1) | A removed service's unit that the user changed is deleted | `remove-service` only while the unit is exactly the one hub installed (digest from the history); backed up for rollback | `v1.1 service deactivation and removal > a unit the user changed is never removed`, `… a later failure restores the unit and reactivates the service` |

### 4.1 Requirement → acceptance mapping

| Requirement (feature brief) | Contract | Check |
|---|---|---|
| Signed standalone hubctl before any harness | ArtifactManifest, TrustRoot, `install-artifact` | T1–T4 tests |
| `hub` = `hubctl`, authority only from credentials | `commandSurface` | T16 |
| Canonical `machine enroll`/`machine status`, harness-independent, one identity | `MachineEnrollment`, `CredentialStore`, `EnrollmentStatus`, `enroll-machine` | `EnrollmentStatus > …` |
| Discover → preview → explicit apply (or Ansible of the same plan) | DiscoverySnapshot, SetupPlan, PreviewToken | T5, `planDigest is deterministic…` |
| Real harness/provider verification | `verify-harness`, `isHarnessReady` | T14 |
| Optional bounded launch | `launch-session` (`maxDurationS`), profile `launch` | `unboundedLaunch` (profile and action) |
| Harness order OpenCode → Claude Code → Codex | `HARNESS_ORDER`, registry, profile order | `the registry orders adapters…`, `PROFILE_INVALID harnessOrder` |
| Profiles session-only / launch-node / full-harness | Profile | `Profile > …`, `PROFILE_INVALID` |
| OpenShell opt-in discovery/verification only | `RUNTIME_IDS`, `verify-runtime`; registry refuses `openshell` as a harness | `…refuses duplicates` |
| No arbitrary shell/SSH/remote exec | Action union | T12 |
| Unprivileged default, explicit escalation and activation | `escalation`, `confirm` | T13 |
| No credentials in plans, journals, logs, Ansible | `findSecrets` in every validator | T9 |
| Preserve unrelated user config; refuse conflicting edits | `merge-config`, `write-file`, recovery | T10 |
| Authenticate pinned artifacts; reject wrong platform, tampering, downgrades | artifact.ts | T1–T4 |
| hubctl installs pinned harnesses (OpenCode → Claude Code → Codex) through a typed action; install ≠ readiness | `install-harness`, `HarnessPin`, `checkHarnessPin`, `checkHarnessEvidence`, plan install→verify rule | T19–T22, `plans with harness installs` |
| Symlinked configs refused with the exact edit emitted | `ManualEdit`, `SetupPreview`, `previewApplicable` | T23 |
| Apply lock; previews bound + revalidated | ApplyLock, `revalidatePreview` | T5, T7 |
| Ownership journal, recovery, no stale credentials, no overwrite of user edits | journal.ts | T8, T10, T11 |
| Linux + macOS enumerated, others fail explicitly | platform.ts | T15 |
| Lossless config merging (src/config.ts drops unknown keys) | `CredentialStore` contract, `preserveUnknown: true` | integration item I4 |
| v1.1: preserve user config structurally (JSONC with comments) | `merge-config` on `json`/`jsonc`, §3.12.1; `unmergeable-format` manual edits | T10 |
| v1.1: one snapshot digest across preview, apply, audit and Ansible | `snapshotDigest` | T26 |
| v1.1: correct paths inside containers | `ExecutionContext`, `rootPathIn` | T24 |
| v1.1: the same plan digest on the direct and Ansible paths | profile/planner `enrollment: "separate"`, Ansible renderer | `v1.1 separate enrollment > …`, `v1.1 the Ansible path enrolls separately > …` |
| v1.1: immutable, versioned harness installs with atomic switching and rollback | `harnessVersionRef`, `harnessCurrentRef`, `select-harness-version` | T22 |
| v1.1: profile downgrades remove what they can, with consent | `deactivate-service`, `remove-service`, `planProfileChange({services})` | T13, T27 |
| v1.1: rebase profiles from the catalog revision they came from | `Profile.revision` (profile v2), `rebaseProfile` | `v1.1 profile revisions > …` |
| v1.1: precise outcomes for enrollment and planning | `enrollment_denied`, `enrollment_expired`, `cancelled`, `escalation_required`, `no_service_manager`, `insecure` | `v1.1 codes > …`, `v1.1 enrollment error codes > …` |

## 5. Installer-source authenticity per harness

**Decision (Q1–Q4):** hubctl v1 installs pinned harnesses, in the order OpenCode, Claude Code, Codex.

- **Trust model.** Trust is transitive. Hub's own signed hubctl release manifest pins every harness artifact by
  exact version, platform, upstream URL, size and sha256 (§3.6.1).
- **Unsigned upstreams.** An upstream without signatures (OpenCode) is acceptable only through that pinned digest.
  An unpinned or mismatched artifact is always rejected, and the downgrade policy applies.
- **Upstream evidence.** Upstream signatures are optional extra evidence: they are recorded, and a failure
  rejects the artifact.
- **What stays with the user.** Provider and interactive harness logins stay user-local. An install is never
  readiness; readiness comes from real probes (§3.10).

The table records how each upstream distributes and authenticates its builds as of 2026-10-28, from upstream docs
and the GitHub releases API. The release process that writes the pins (I5) re-checks it for every release.

| Harness | Upstream distribution | Hub pin (mandatory) | Optional evidence recorded | Open items |
|---|---|---|---|---|
| OpenCode | `opencode.ai/install` script → GitHub releases `opencode-<os>-<arch>[-musl\|-baseline].{zip,tar.gz}` (`anomalyco/opencode`); npm `opencode-ai`; Homebrew. GitHub's API reports a per-asset sha256; the install script checks nothing (upstream #31390, #29923); no signatures found. | version + sha256 (+ size, URL) in hub's signed manifest; the only trust anchor | none | **HBS-06:** confirm the upstream source of the OpenCode **2.x** CLI. The latest GitHub release seen was `v1.19.5`, while this repo targets the OpenCode 2 SDK (`@opencode/client` ^2.0.26). This is not a blocker for the contract: the pin records whatever URL HBS-06 confirms. |
| Claude Code | Native installer → `downloads.claude.ai/claude-code-releases/<version>/` with a per-release `manifest.json` (sha256 per platform) and detached GPG `manifest.json.sig` (≥ 2.1.89; key `https://downloads.claude.ai/keys/claude-code.asc`, fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`, per upstream docs); macOS binaries codesigned and notarized ("Anthropic PBC"); apt/dnf/apk, npm, Homebrew. | sha256 pinned in hub's manifest (mandatory) | `gpg-manifest` (if a verifier is available), `macos-notarization` (macOS): each recorded as verified, unavailable or deferred. **No hard `gpg` dependency**: without `gpg`, the check is `unavailable`. | Which OpenPGP verifier the adapter uses when present (local `gpg` as a typed probe, or an embedded verifier) is an adapter detail. |
| Codex | GitHub releases `openai/codex` (`codex-<rust-triple>.tar.gz/.zst`, `.dmg`); `.sigstore` bundles for Linux musl assets; macOS codesigned; npm `@openai/codex`, Homebrew cask. | sha256 pinned in hub's manifest (required whenever sigstore is not verified, which in practice means always) | `sigstore` where a bundle exists (pins list it only then): verified or unavailable; never neither, because the digest is always checked | An upstream report (#56894, 2026-10-25) shows a macOS signature validation failure. Treat evidence as fallible and report it. |

## 6. Fixtures for dependent tasks

`packages/cli/test/bootstrap/fixtures.ts` exports plain-JSON, clock-free fixtures. Each `*_INVALID` map is
`{label: {value, code}}`, naming the issue code the check must report.

- Discovery: `DISCOVERY_DARWIN`, `DISCOVERY_LINUX_CONTAINER` (a shim plus a verified harness),
  `DISCOVERY_UNSUPPORTED`, and `DISCOVERY_INVALID`.
- Profiles (v1.1: version 2): `PROFILE_SESSION_ONLY`, `PROFILE_LAUNCH_NODE`, `PROFILE_FULL_HARNESS`,
  `PROFILE_SEPARATE_ENROLLMENT`, `PROFILE_V1` (migrated by `PROFILE_MIGRATIONS[1]`), `PROFILE_V0` (for an injected
  migration), and `PROFILE_INVALID`.
- Actions and plans: `ACTIONS` (one valid action per kind), `EXEC_SMUGGLING`, `ACTION_INVALID`,
  `PLAN_LAUNCH_NODE`, `PLAN_ELEVATED`, and `PLAN_INVALID`.
- Previews: `PREVIEW`, `PREVIEW_INVALID`.
- Artifacts: `MANIFEST_UNSIGNED`, `TRUST_ROOT_TEMPLATE`, `MANIFEST_INVALID`. Tests sign manifests with an
  **ephemeral** ed25519 key generated at test time; no key material is committed.
- Enrollment: `ENROLLMENT_VERIFIED`, `ENROLLMENT_UNCONFIGURED`, `ENROLLMENT_INSECURE` (v1.1), `ENROLLMENT_INVALID`.
- Journal and lock: `JOURNAL_APPLYING` (directory, config, credential and pending-file entries), `JOURNAL_INVALID`,
  `JOURNAL_SKIPPED_ENTRY` and `JOURNAL_PENDING_CREDENTIAL` (v1.1), `LOCK`.
- Readiness: `VERIFICATION_READY`, `VERIFICATION_INSTALLED_ONLY`.
- Pinned harness installs:
  - `HARNESS_PINS` (in `MANIFEST_UNSIGNED.harnesses`), and the install actions `ACTIONS["install-harness"]`
    (OpenCode), `INSTALL_CLAUDE` and `INSTALL_CODEX`.
  - `PLAN_HARNESS_INSTALL` (v1.1: install → select → verify), `SELECT_CLAUDE`, and the new kinds in `ACTIONS`
    (`select-harness-version`, `deactivate-service`, `remove-service`).
  - Threat cases: `HARNESS_ACTION_INVALID`, `HARNESS_PIN_INVALID`, `PLAN_HARNESS_INVALID`.
  - Rollback (v1.1 layout): `HARNESS_INSTALL_JOURNAL_ENTRY` (a fresh version directory: removed) and
    `HARNESS_JOURNAL_ENTRY` (the `current` link: restored from its backup).
- Manual edits: `SYMLINK`, `MANUAL_EDIT_MERGE`, `MANUAL_EDIT_MCP`, `MANUAL_EDIT_TOML` (v1.1, `unmergeable-format`),
  `MANUAL_EDIT_INVALID`.
- Envelopes: `ENVELOPE_OK`, `ENVELOPE_ERROR`, `ENVELOPE_INVALID`.

Note: `scripts/test-ci.sh` runs `packages/*/test/*.test.ts` (one directory level). Dependent tests belong in
`packages/cli/test/*.test.ts` and import from `./bootstrap/fixtures`.

## 7. Integration (HBS-13)

The integration requirements I1–I4 and I7 (the CLI, node.ts and spoke-services.ts, main.ts, the credential store,
the v1.1 wiring) are done by HBS-13; I5 and I6 (the release) by the release module. This section records what the
integration is and what is still open.

### 7.1 The command surface

`packages/cli/src/setup/` composes the modules; `cli.ts` registers the `machine` and `setup` groups.

| File | Role |
|---|---|
| `commands.ts` | `machine enroll|status`, `setup discover|preview|apply|verify|drift|rollback|recover|ansible`: flags, the envelope (`--json`), text output, `exitFor`. |
| `runtime.ts` | The composition root: the adapter registry, the contributors and the executors, built once per command from the same profile and choices, so preview and apply plan the same digest. |
| `contributors.ts` | `hubctlContributor` (install-artifact `user-bin:hubctl` + link `user-bin:hub`, from a verified manifest), `enrollmentContributor` (inline enrollment), `refusing` (a Result refusal becomes a typed `PlanRefusal`). |
| `dispatch.ts` | `dispatchByHarness` and `dispatchHarnessSource` (amendment A2): one executor per kind, routed by `action.harness`; an unregistered harness is refused at preflight. |
| `spoke-probe.ts` | `spoke-connected` for all three adapters: `GET /spoke/presence` with the machine credential (§7.3). |
| `state.ts` | The setup request file, `state:hub/bootstrap/state.json` and the requests by plan digest (§7.4). |
| `launch-driver.ts` | The `LaunchDriver` of the verification launch, over the existing hub launch API (the user's `hub login`). |

- **Preview and apply.** `setup preview --out <file>` writes a `hub.setup-request` (mode 0600): the
  `SetupPreview` plus the profile and choices apply must re-plan with (`--enrollment`, `--confirm-activation`,
  `--allow-downgrade`, `--workspace-root`, `--verify-launch`, `--server`/`--name`). `setup apply --preview <file>`
  rediscovers and re-plans with them inside the engine's `replan` hook (`revalidateApply`), and the engine applies
  that fresh plan. Consent is given again at apply (`--escalate`, `--confirm-activation`, `--allow-downgrade`); the
  Ansible role's argv (`directCommands`) is unchanged.
- **Refusals.** Adapters and contributors that throw a contract refusal (`OpencodePlanError`, `PlanRefusal`) become
  envelope errors with their code (amendment A1 is met at the composition layer; `planSetup` is unchanged). A planner
  issue code that is not an `ErrorCode` maps to `invalid` (exit 2).
- **Profiles.** `--profile` takes a catalog id, a file or `-`; documents are read with `loadProfile` (version 1
  migrates to 2). Without `--profile`, `verify`/`drift`/`preview` use the applied profile, else `session-only`. A
  profile that drops services plans their typed removal (`planProfileChange`, needs `--allow-downgrade`).
- **Services.** The node-services planner runs as a contributor with the service layout: the standalone
  `user-bin:hubctl` when the plan installs it, else this process (`programLayout`). Units are rendered by
  `renderServiceUnit` for both `setup` and `hub node|claude-code|codex-spoke install` (I2; no template is read from
  `scripts/` at run time). The `ServiceControl` is `createServiceControl` over `spawnManagerRunner`; the
  planner's notes (activation, linger) are printed as warnings.
- **Enrollment.** `machine enroll` (`credentialStoreFor(env, home, {migrate: true})`, prompts on stderr) and
  `machine status` (revoked → 9, offline → 7, `insecure` reported with its warning). Inline enrollment is an
  `enroll-machine` step (class credential, `config:hub/config.json`; refused when `HUB_SPOKE_CONFIG` points
  elsewhere), whose undo clears the credential. main.ts aborts `machine enroll`, `setup apply` and `setup recover` on
  SIGINT/SIGTERM (I3).
- **Executable.** Standalone builds compile `main.ts`, which reaches `release/trust-root.ts` through `commands.ts`
  (a test builds main.ts with a marker define and finds it). The `hub`/`hubctl` launchers exec `~/.local/bin/hubctl`
  when it exists (OpenCode README: authority).
- **Harness binaries.** Claude Code: `HUB_CLAUDE_BIN` > `binary` in `claude-code.json` (next to config.json, so it
  follows `HUB_SPOKE_CONFIG`) > PATH, for the daemon, `hub claude` and the node (`claudeBinary`). Codex:
  `HUB_CODEX_BIN` > `data/hub/harnesses/codex/current/bin/codex` > PATH (`codexBinary`), for `hub codex` (which
  passes `HUB_CODEX_BIN` on to the spoke it starts), the spoke and its unit. `CODEX_APP_SERVER_ARGS` is shared by
  the spoke and the adapter's probe launcher.

### 7.2 Engine additions

- `ApplierConfig.keepBackups`: a committed transaction keeps its backups (the CLI sets it), and
  `Applier.rollback({to?})` undoes committed transactions newest first with the recovery rules. Without kept
  backups a restore is a conflict, never a guess.
- `planSetup` no longer treats the final symlink of `link-executable` / `select-harness-version` as written through
  (they replace it atomically); a symlinked directory above them is still refused.
- **Bounded memory (HBS-12).** A 4 GB host was OOM-killed installing OpenCode 2.2.0 (a 116 MB tar.gz holding a
  ~350 MB binary): the download, the inflated tar, each member, the tree change and the staging writes each held a
  whole copy. Large content now never passes through memory whole:
  - `TxFs` writes and reads in chunks (`createExclusive`, `readRange`); file and tree states are digested, backups
    taken and restored, in chunks (`transaction/stream.ts`, `CHUNK_BYTES` = 1 MiB).
  - Each step gets a `StagingArea` (`StepContext.staging`, `state:hub/bootstrap/staging/<txID>`, owner-only): a
    `HarnessSource` streams its download into it (`fetch(action, staging)`), and the staging area records the
    sha256 and size of what it wrote. `install-harness` checks the pin (and the upstream evidence) against that
    digest, never one a source reports, before `unpack(action, file, staging)` streams the archive's members into
    staging files (`adapters/archive-stream.ts`: a block-by-block tar reader, zip members by offset from the central
    directory). Limits hold while inflating: the inflated total, and a zip member never past its recorded size.
    Every member is judged before its body is read, and its CRC-32 (gzip trailer, zip directory) is checked.
  - **Decision: hub inflates by itself** (`adapters/inflate.ts`, RFC 1951/1952, synchronous over the staged file,
    32 KiB window, 64 KiB output chunks). `node:zlib`'s one-shot calls hold the whole output, and with the real
    OpenCode 2.2.0 darwin zip Bun 1.3.5's zlib *streams* stalled for good (no output, no error) in about half the
    runs once the consumer hashed and wrote each chunk, even when it yielded to the event loop; Node does not. The
    cost is speed: ~3-7 s for 247 MB on a loaded laptop, against ~2 s for zlib.
  - A `tree` change, and a `file` change, may name a `StagedFile` instead of bytes. The engine moves a file its
    staging area wrote into the staged tree (copying across filesystems), and copies any other file (hubctl's own
    executable for `install-artifact`) in chunks, checking the digest while it copies (`integrity_mismatch`,
    nothing replaced). The staging directory is removed after each step and swept under the lock; it is never
    needed for recovery or resume.
  - Measured (real engine and OpenCode source in a child process, `test/bootstrap/memory-probe.ts`): with the
    real OpenCode 2.2.0 assets the peak RSS of the whole process fell from 1.77 GB to 0.19 GB (linux-x64-baseline
    tar.gz) and from 1.00 GB to 0.19 GB (darwin-arm64 zip); with a synthetic 300 MiB binary, the growth over the
    runtime fell from 1.97 GB (tar.gz) and 1.70 GB (zip) to about 70 MB. `bootstrap-install-memory.test.ts` keeps it
    so (32 MiB always, 300 MiB with `HUB_MEMORY_TEST=1`).

### 7.3 Spoke presence (central)

`GET /spoke/presence`, machine token only (a launch-bound, unknown or revoked token is 401): `{machineID, spokes:
[{harness, evidence, features}]}` for the caller's own machine, nothing about sessions, directories, pids or other
machines. It is read-only and the only central change; no exec channel. OpenCode is connected when an `opencode` spoke
is; Claude Code when a `claude-code` spoke is, and conformant when it reports `hooks` evidence; Codex when a `codex`
spoke is. In cluster mode it answers from the pod's registry catalog, like `GET /api/machines`.

### 7.4 What persists

- The engine's journals (`state:hub/bootstrap/journal/<tx>.json`) and plans (`<tx>.plan.json`, pinned by
  `planDigest`) are the applied plans and the used-nonce record.
- `state:hub/bootstrap/state.json` (`hub.bootstrap-state`): the applied profile, choices and catalog revision, the
  last transaction and plan digest, and the security floors (hubctl's `minimumVersion`, each harness pin's
  `minimumVersion` for this target), which only rise and feed the downgrade policy.
- `state:hub/bootstrap/requests/<hex>.json`: the request each applied plan was made from (resume and rollback
  re-plan with it).
- `state:hub/bootstrap/staging/<txID>/` is scratch space only (§7.2, bounded memory): it holds a step's download
  and unpacked members while the step runs and never outlives it.
- The drift `Observation` is read fresh by `setup drift` from the files the desired plan manages (never persisted:
  it must describe the files now). A field the adapters no longer plan because it is converged is taken from the
  applied plan, so it reads as in sync, not retired.

### 7.5 Release (I5, I6; built by the release module, `packages/cli/src/bootstrap/release/README.md`)

- **I5 release (`scripts/build-binaries.sh`, `.github/workflows/release.yml`)**
  - These currently build the central **server** (`.build/hub.ts`) as `hub-<target>`, including `windows-x64`.
  - Add a separate hubctl build: `bun build --compile --target=<SUPPORTED_TARGETS[].bunTarget>
    packages/cli/src/main.ts --outfile dist/hubctl-<target>`, for the four supported targets only.
  - Emit `hubctl-manifest.json`: the `ArtifactManifest` body, with hubctl sizes and sha256 **and the harness pins**,
    which come from a reviewed, checked-in pin list that the release job re-downloads and digests.
  - Sign it with a detached ed25519 signature, from the single release key held as a GitHub Actions secret (e.g.
    `HUB_RELEASE_SIGNING_KEY`) and readable only by the release job (decision Q5). Never commit a key.
  - Smoke test `hubctl --version` and `hubctl machine status --json` on linux-x64.
- **I6 shipped trust root**
  - hubctl embeds the `TrustRoot` (public keys only) at build time: v1 has one active key, threshold 1. Rotation
    documents are published next to releases and accepted through `rotateTrustRoot`.


### 7.6 Open items and known limits

- **A3:** a JSON/JSONC config that does not parse is still a bare `manual_edit_required` refusal (exit 10) from the
  OpenCode adapter, not a structured `unmergeable-format` edit; the message names the file.
- **A5:** `previous` of `install-harness` / `select-harness-version` comes from the history only when hub installed
  the earlier version; discovery does not record a tree digest.
- **A6 (resolved, HBS-12):** a hub-installed harness goes on PATH through a typed `link-executable` in `user-bin`
  (`~/.local/bin/opencode` → `data:hub/harnesses/opencode/current/bin/opencode`; `claude` and `codex` likewise), from
  `harnessLinkContributor`. It is planned only for a harness hub makes current (this plan selects it, or its `current`
  binary exists), only when no other command of that name is on PATH, and only when `user-bin` holds nothing of that
  name but a link into hub's own harness directory: a user's binary is never shadowed or replaced. It is journaled
  (class `link`) and rolled back like the hub alias. When `user-bin` is not on PATH, preview and apply say so.
- **Activation priors** are kept in memory: after a crash, recovery unloads a service even if it was loaded before
  the apply (no persistence without consent); a rolled-back unit file is restored but the running service is not
  reloaded. A dedicated `service_failed` code is not done.
- **Root directories** (v1.2): a missing root under the home root (a fresh home without `~/.local/bin` or
  `~/.local/share`) is journaled level by level as `directory` entries of the `home` root, so a rollback removes what
  the transaction created, only while it is empty. A root outside home, below a symlink, or with no home directory is
  still created unjournaled, as before. The applier's own state directory (`state:hub/bootstrap`, which holds the
  journal) is never removed.
- **Codex notarization** is allowed as evidence but not checked by the Codex source.
- A Codex or Claude Code on PATH wins over the hub-installed one at discovery, so a unit planned before and after an
  install can differ (a second apply then rewrites it).
- The verification launch uses `checkout` mode in the first workspace root, which must be a git repository, and
  needs `hub login` with an app token allowed to launch.
- The release key, its trust root (`trust-root.json`) and the reviewed pin list (`harness-pins.json`) are not set up
  yet (§7.5): until they are, no build can verify a release manifest.

### 7.7 HBS-12 acceptance on a clean Debian VM

- **Sharing mode.** The OpenCode spoke connects only while `config.json`'s `mode` is not `"off"`, and the spoke's
  default is `"off"` (the `/hub` dialog asks for a mode after enrolling; hubctl cannot ask). The credential store
  (`ConfigCredentialStore.write`) therefore sets `mode: "always"` when the file has no `mode` key, so a
  hubctl-enrolled machine connects with no manual edit. An explicit value, `"off"` included, is never changed:
  `machine enroll` reports it as a warning, and `setup apply`/`setup verify` replace the OpenCode "start OpenCode"
  next step with one that says the mode is off. `machine enroll` on an already enrolled machine adds the default to a
  config with no `mode` (written by an earlier hubctl). A rollback of an inline enrollment clears the credential and
  leaves the mode; without a token it does nothing.
- **Plugin cold start.** On the first use of a directory OpenCode 2.2's service activated the plugin in ~5.4 s, past
  the CLI's 5 s bound (HTTP 503). Measured: importing `@opencode/plugin`'s runtime entry (for `Plugin.define`, an
  identity function) cost ~0.9–1.6 s of schema modules; the plugin now imports its types only, and loading the entry
  fell from ~1.1–2.6 s to ~0.3 s on a laptop. `setup()` registers its hooks, tools and RPC concurrently; it never
  awaits the hub (the spoke connects in the background) or the network. The launchers are a few small synchronous
  writes, skipped when unchanged, and stay in `setup()`. The OpenCode probes retry once on the 503 (adapter README).
- **Converged reruns.** `hubctlContributor` compares the installed `user-bin:hubctl` with the pinned artifact by
  digest (read in chunks) and the `hub` link by its target, so a rerun from any hubctl path plans neither.
  `planSetup` leaves out `state-dir` once `state:hub/bootstrap/state.json` exists (a committed apply wrote it; the
  apply lock creates the directory but never that file, so a fresh preview and apply's locked re-plan still agree).
  A converged session-only host plans only `verify-opencode`.
- **Deferred: plugin diagnostics.** The service-spawned `opencode serve --service` discards stderr, so the plugin's
  `[hub]` errors are invisible. `@opencode/plugin` 2.2's server plugin context has no logger, so they cannot be routed
  into OpenCode's log yet.

## 8. Decisions (resolved 2026-10-28) and open items

- **Q1. Resolved:** hubctl v1 **installs pinned harnesses** (OpenCode first, then Claude Code, then Codex):
  - Through the typed `install-harness` action, which has no command-carrying field. It carries the harness, the
    exact version, the platform, the source reference + sha256, optional evidence, the install root as named
    root + relative path, the hub owner record, and rollback by restoring the previous binary/version.
  - Trust is transitive through hub's signed manifest pins. Unpinned or mismatched artifacts are rejected, and the
    downgrade policy applies.
  - Provider and interactive auth stays user-local. Install is not readiness.
- **Q2. Resolved:** OpenCode is pinned by version + sha256 in hub's signed manifest. Open item for **HBS-06**:
  confirm the upstream source of OpenCode 2.x. This does not block the contract.
- **Q3. Resolved:** Claude Code requires the sha256 pinned in hub's manifest. The upstream GPG manifest and macOS
  notarization are optional evidence, recorded as verified or unavailable in the plan output. There is no hard
  `gpg` dependency.
- **Q4. Resolved:** Codex sigstore is verified when available and recorded as evidence. Otherwise the pinned
  sha256 is required. Never neither, since the pin is always checked.
- **Q5. Resolved:** the hubctl release-signing key is a single ed25519 key, held as a GitHub Actions secret of the
  release workflow. The public key is embedded in hubctl. Threshold 1. The forward-rotation trust root is kept.
- **Q6. Resolved:** the preview token is unsigned and accepted, because apply rebuilds the plan and compares.
- **Q7. Resolved:** musl Linux is unsupported in v1.
- **Q8. Resolved:** symlinked configs are refused. hubctl emits the exact, structured, secret-free edit as a
  `ManualEdit` blocker in the preview, for the user to make in their dotfiles repository (§3.12).
- **Q9. Resolved:** exit codes 10–15 are approved.

Open items carried to later tasks:

- HBS-06: the OpenCode 2.x upstream source.
- The Claude Code adapter's choice of OpenPGP verifier when one is available.
- The release job's harness pin list and its review process (I5).
- The integration's own open items and known limits: §7.6.

Resolved by amendment v1.1 (review findings on the merged modules, §9): the duplicated snapshot digest, container
path resolution, enrollment in Ansible-comparable plans, imprecise planner and enrollment codes, an existing
plain-http credential reported as an error, the recovery of an interrupted enrollment, backups for skipped entries,
the harness `current` layout and `HARNESS_JOURNAL_ENTRY`, JSONC configs refused as conflicts, service removal on
downgrade, and rebases without a recorded catalog revision. None of the three open items above is affected.

## 9. Amendment v1.1 (2026-10-28)

| # | Amendment | Contract | Modules | Tests |
|---|---|---|---|---|
| 1 | Canonical snapshot digest, excluding `capturedAt` | `snapshotDigest` (§3.2, §3.4) | preview (re-exports it), transaction (`FreshPlan.snapshot`), profiles (audit), ansible (`snapshot` input) | `bootstrap-contracts-v11`, `-preview-v11`, `-transaction-v11`, `-profiles-v11`, `-ansible-v11` |
| 2 | Container roots: `path` = host view, `containerPath` = container view | `ExecutionContext`, `rootPathIn`, `resolvePathRef(…, context)`, `executionContextOf` (§3.2) | discovery, preview links and manual edits, transaction (`createApplier({context})`, store, parents) | `v1.1 container roots`, `v1.1 execution context` |
| 3 | Enrollment inline/separate | `Profile.enrollment`, `ENROLLMENT_MODES` (§3.4, §3.5) | planner option `enrollment`, previewSetup/revalidateApply, Ansible renderer sets `separate` | `v1.1 separate enrollment`, `v1.1 the Ansible path enrolls separately` |
| 4 | Codes: `escalation_required`, `no_service_manager`, `enrollment_denied`, `enrollment_expired`, `cancelled`; `insecure` status | `IssueCode`, `ERROR_CODES`/`exitFor`, `ENROLLMENT_STATES` (§3.8, §3.11) | planner, profiles (desired), enrollment (enroll, status) | `v1.1 codes`, `v1.1 planner codes`, `v1.1 enrollment error codes`, `v1.1 insecure stored credentials` |
| 5 | Journal: pending credential without `after` is cleared; skipped entries need no backup | `recoveryDecision`, `validateJournal` (§3.9) | transaction engine relies on the contract rule | `v1.1 journal` |
| 6 | Versioned harness layout and `select-harness-version` | `harnessVersionRef`, `harnessCurrentRef`, action + plan rules, fixtures (§3.3, §3.4, §3.6.1) | transaction executor, discovery (`current`), profiles history (`restores` from the select) | `v1.1 harness layout`, `v1.1 select-harness-version`, history tests |
| 7 | Lossless JSONC edits; `unmergeable-format` manual edits | `MANUAL_EDIT_REASONS`, `unmergeableEditFor` (§3.12, §3.12.1) | transaction json-merge, planner (TOML) | `bootstrap-transaction-jsonc`, `v1.1 unmergeable-format manual edits` |
| 8 | `deactivate-service`, `remove-service` | actions + plan rule (§3.3, §3.4) | transaction executors (`ServiceControl`, `remove` change), profiles downgrade (`planProfileChange({services})`, `installedServiceUnits`) | `v1.1 service deactivation and removal`, `v1.1 downgrades plan typed service removal` |
| 9 | `Profile.revision`, profile version 2 + migration | `PROFILE_VERSION = 2`, `PROFILE_MIGRATIONS[1]`, `PLAN_PROFILE_VERSIONS` (§3.5) | catalog (revision on every profile), `rebaseProfile({catalogs})` | `v1.1 profile v2`, `v1.1 profile revisions` |

Choices made in v1.1:

- `remove-service` removes the unit as a journaled, backed-up file change, and is not an opaque external effect, so
  a rollback can restore exactly the unit it removed. `deactivate-service` is an external effect with an undo.
- The new error codes keep the exits those outcomes already had (5 and 4), so scripts keyed on exit codes keep
  working.
- Only the profile changes schema version. The other documents gain additive fields or values and keep theirs.

## 10. Amendment v1.2 (2026-10-29): install is not readiness

**Context (HBS-12 acceptance).** On a clean, enrolled host, `hubctl setup apply` for `session-only` installed hubctl,
linked `hub`, installed and selected OpenCode and merged its plugin and MCP config, then `verify-opencode` failed:
`provider-auth` (`opencode models` exited 1: the user had not logged in yet) and `spoke-connected` (OpenCode had never
been started). The whole transaction rolled back (exit 15). Both probes can only pass **after** the install, because
the user needs the installed OpenCode to run `opencode auth login` and to start it, so apply could never succeed on a
fresh host.

**Contract.** `harness.ts` gives every probe kind a class, `PROBE_CLASS`. The class belongs to the kind, never to a
probe's detail, so harness output cannot argue its way out of a rollback:

| Class | Probe kinds | What a non-passing probe means |
|---|---|---|
| `integrity` | `presence`, `version-exec`, `api-health` | The install is broken: the binary is missing or does not run, is not the pinned version, is a container shim, or its local API does not answer. |
| `user` | `provider-auth`, `spoke-connected` (Claude Code: spoke + conformance) | The install is fine, but it waits on the user: their provider login, or a harness or spoke they start. |

`harnessReadiness(verification, now, also?)` classifies a verification against `REQUIRED_PROBES` plus the probes the
`verify-harness` action asks for (`also`; Codex always adds `api-health`):

- Each probe gets a status: `pass` (present, passing, fresh), `pending` (a `user` probe that is not passing, or
  stale), `fail` (an `integrity` probe that is not passing or stale, or **any** required probe that was not run).
- The harness state: `failed` if any probe fails, else `pending` if any is pending, else `ready`. `ready` holds
  exactly when `isHarnessReady` does (with `also` empty).
- `nextSteps`: for `pending`, the user's step for each pending probe (`PENDING_STEPS`, e.g. "run `opencode auth
  login`", "start OpenCode"), then `VERIFY_STEP` ("then check readiness with `hubctl setup verify`"). Empty
  otherwise. These are instructions for the user, never commands hubctl runs.

**Apply.** Each `verify-harness` executor (OpenCode, Claude Code, Codex) classifies its verification and reports it
(`onReadiness`), through one gate (`adapters/readiness.ts`, `ReadinessGate {requireReady, onReadiness}`):

| State | Default apply | `apply --require-ready` |
|---|---|---|
| `ready` | step done | step done |
| `pending` | step done: the harness is committed as **installed, not ready** | `harness_not_ready` (exit 15), rolled back |
| `failed` | `harness_not_ready` (exit 15), rolled back | `harness_not_ready` (exit 15), rolled back |

- The executors' own default is strict (`requireReady` absent = true), so a building block never loosens by
  omission. The composition root (`setup/runtime.ts`, `readinessGate`) sets it per harness: strict with
  `--require-ready`, and always strict for the harness of a requested `--verify-launch` (the bounded launch needs a
  ready harness; the launch step itself stays strict too).
- `hubctl setup apply` reports `data.ready` and `data.harnesses[]` = `{harness, ready, state: "ready" |
  "installed-not-ready" | "failed", probes: [{kind, class, status, detail?}], nextSteps}` (also on failure), and
  in text prints each harness, its probes and next steps. A not-ready harness is also a warning.
- `hubctl setup verify` stays the strict readiness gate (exit 15 unless every harness is ready) and reports the same
  `harnesses[]` shape. `hubctl setup recover --resume` takes `--require-ready` too.
- Nothing advertises a capability before every probe passes: `claudeReadiness` and `codexCapabilities` are
  unchanged, and `pending` is never `ready`.
- Journals are unchanged and valid: `verify-harness` is still an `external` entry, `done` when the step passes.

**Rollback leftovers.** A rollback now removes the root directories the transaction created (§7.6, "Root
directories"). A directory hub created that now also holds files hub did not write (OpenCode's own probe writes
into `~/.config/opencode`) is kept and reported in `TxReport.kept` (`data.kept`; text: `hubctl: note: kept …`), an
informational note, not a conflict or a warning. Its files are not the user's edits of hub's files, and nothing of
the user's was touched.

**Decision: probes use the real configuration.** Probes run with the user's real environment and XDG directories,
not an isolated `XDG_*`. Readiness must describe what the user will run: their provider login and config live there,
and an isolated config would report "not logged in" for a user who is. The cost is that a probe can write into the
harness's config directory, which the rollback note above makes harmless.

**Ansible.** The role never passes `--require-ready` unless `hub_bootstrap_apply_require_ready` is set (rendered from
`hubctl setup ansible --apply-require-ready`, `ROLE_APPLY_FLAGS`); readiness is gated separately by its `setup
verify` step (`hub_bootstrap_require_ready`, default true), which fails the play with each harness's state and next
steps while the install stays applied. Rerunning the play after the next steps converges: apply has nothing to do
and verify passes.

**Deferred: CPU feature requirements.** OpenCode's Bun runtime needs SSE4.2 even in its x64 baseline build, so on a
host without it (a QEMU guest with the default `kvm64`/`qemu64` CPU model) `version-exec` fails, which v1.2 already
classifies as an integrity failure and rolls back. A preview-time block (a discovery fact for the x86-64 feature
level from `/proc/cpuinfo` or the macOS `machdep.cpu` sysctl, and an optional `cpu` requirement on a harness pin)
would refuse earlier and with a clearer reason. It needs a new read-only probe capability (macOS has no file to
read), a discovery snapshot field, a pin field in the signed manifest and a planner refusal, so it is left for a
later amendment.

| # | Amendment | Contract | Modules | Tests |
|---|---|---|---|---|
| 1 | Probe classes and classified readiness | `PROBE_CLASS`, `harnessReadiness`, `PENDING_STEPS` (§3.10) | adapters' verify executors (`adapters/readiness.ts`), `setup apply/verify/recover`, runtime `readinessGate` | `bootstrap-contracts-v12`, `bootstrap-readiness-v12`, `setup-readiness`, `setup-cli` (fresh host) |
| 2 | Root directories journaled; created-but-foreign directories kept as notes | `directory` entries of the `home` root (§7.6); `TxReport.kept` | transaction engine, `setup` output | `bootstrap-transaction-dirs`, `setup-cli` (fresh host) |
| 3 | Apply-only `--require-ready` in the Ansible role | `ROLE_APPLY_FLAGS`, `hub_bootstrap_apply_require_ready` | ansible renderer and role | `bootstrap-ansible`, `bootstrap-ansible-role` |
