# Bootstrap contracts (v1)

Status: **frozen v1** (amended on 2026-10-28, before any release, with the user's decisions on the open
questions: pinned harness installs, manual edits for symlinked configs, and release signing; see §8). Code: `packages/cli/src/bootstrap/contracts/`. Tests: `packages/cli/test/bootstrap-contracts.test.ts`.
Shared fixtures: `packages/cli/test/bootstrap/fixtures.ts`.

This document defines the contracts for bootstrapping a machine into Hub with a standalone `hubctl`, which is
installed before any harness and then installs pinned harnesses itself: the documents each layer exchanges, the rules that validate them, the threat model they
defend against, and the edits needed to integrate them into the CLI. It holds no implementation of discovery,
planning, applying or enrollment; later tasks build those on these contracts.

Changing a contract means a new schema version, plus a migration wherever documents persist (see `migrateProfile`).
The meaning of an existing version never changes in place.

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
| `paths.ts` | `PathRef` (named root + safe relative path), `resolvePathRef`, `checkNoSymlinkEscape`, `ELEVATED_ROOTS`. |
| `exec.ts` | Executable/argv contract: `programLayout`, `serviceArgv`, `SERVICE_COMMANDS`, `EMBEDDED_ASSETS`. |
| `harness.ts` | `HarnessAdapter` (discover/plan/verify), `Probe`, `REQUIRED_PROBES`, `isHarnessReady`, `createAdapterRegistry`, `EVIDENCE_KINDS`, `HARNESS_EVIDENCE`. |
| `actions.ts` | Typed `Action` union (13 kinds), `ACTION_FIELDS`/`ACTION_OPTIONAL`, `EXEC_KEYS`, `validateAction`. |
| `discovery.ts` | `DiscoverySnapshot`, `validateDiscoverySnapshot`. |
| `profile.ts` | `Profile`, `validateProfile`, `migrateProfile` + `PROFILE_MIGRATIONS` hook. |
| `plan.ts` | `SetupPlan`, `planDigest`, `PreviewToken`, `revalidatePreview`. |
| `preview.ts` | `SetupPreview` (the plan output), `ManualEdit` blocker, `manualEditFor`, `previewApplicable`. |
| `artifact.ts` | `ArtifactManifest` (+ `HarnessPin`s), `VerifiedManifest`, `TrustRoot`, `verifyManifest`, `rotateTrustRoot`, `selectArtifact`, `checkArtifactBytes`, `compareVersions`, `decideInstall`, `checkHarnessPin`, `checkHarnessEvidence`, `decideHarnessInstall`. |
| `credentials.ts` | `CredentialStore`, `MachineEnrollment`, `MachineCredential`, secret-free `EnrollmentStatus`, `enrollmentStatusFrom`. |
| `journal.ts` | `TransactionJournal`, `JournalEntry` (ownership records), `recoveryDecision`/`recoveryPlan`, `JournalHooks`, `ApplyLock`, `lockState`. |
| `envelope.ts` | `ResultEnvelope` (`--json`), `ERROR_CODES`, `BOOTSTRAP_EXIT`, `exitFor`. |

Every validator takes `unknown`, rejects unknown fields, and returns **all** issues. Each issue has a stable `code`:
callers and tests match on the code, never on the message.

## 3. Contracts

### 3.1 Supported platform matrix

| Target | Platform | Arch | libc | Services | Bun build target |
|---|---|---|---|---|---|
| `darwin-arm64` | macOS | arm64 | — | launchd (user agent) | `bun-darwin-arm64` |
| `darwin-x64` | macOS | x64 | — | launchd (user agent) | `bun-darwin-x64` |
| `linux-x64` | Linux | x64 | glibc | systemd `--user` | `bun-linux-x64` |
| `linux-arm64` | Linux | arm64 | glibc | systemd `--user` | `bun-linux-arm64` |

Explicitly unsupported, with the reason reported: `windows-x64`, `windows-arm64` (Windows bootstrap is out of
scope), `linux-x64-musl`, `linux-arm64-musl` (no musl build). Any other target fails with `unsupported_platform`.
A discovery snapshot can *describe* an unsupported host (`supported: false`), but no plan can target one.

### 3.2 DiscoverySnapshot (`hub.discovery-snapshot` v1)

A read-only description of the host: platform/arch/libc/target (with `supported` exactly matching the matrix), OS,
container kind and shims (`host` / `container-shim` / `wrapper`, with `resolvesTo`), package, runtime and service
managers, harnesses, OpenShell presence, the config files the plan might touch (owner, format, digest — never
contents), and root mappings (`home`, `config`, `state`, `data`, `user-bin`, `launch-agents`, `systemd-user`,
`system-bin`, each with an optional `containerPath`).

Harness entries keep **presence apart from health**. `installed: true` means the harness was found. Its
`health.state` stays `unverified` until probes run. `verified` requires at least one passing non-`presence` probe
and no failing ones. A harness that is not installed has no path, version or verified health.

### 3.3 Actions (typed, closed union)

`ensure-directory`, `install-artifact` (hubctl only), `install-harness` (a pinned harness artifact, §3.6.1),
`link-executable` (the hub ↔ hubctl alias), `write-file`
(an embedded or rendered asset pinned by digest, `onConflict: "refuse"` only), `merge-config` (lossless:
`preserveUnknown: true` only, precondition digest, JSON-pointer sets), `register-mcp-server` (registers *this*
hubctl's `mcp` subcommand and never carries a command), `install-service` (an embedded template for that service and
manager, in that manager's root), `activate-service` (`confirm: "explicit"` only), `enroll-machine` (server URL +
machine name, never a credential), `verify-harness` (real probes only), `verify-runtime` (OpenShell, opt-in),
`launch-session` (bounded: 1 s to 24 h).

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
digest of its canonical JSON) is deterministic. It records `hostFingerprint`, `snapshotDigest`, `target`,
`profile {id, version}`, the actions in execution order, and two flags that must be exactly right:
`requiresEscalation` (some action is elevated) and `activatesServices` (some action activates a service). Order
rules: a service is installed before it is activated; a harness is verified before a session is launched on it;
every installed harness is verified later in the plan (install is not readiness); the machine is enrolled at most
once; at most 256 actions.

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

The token is not an authority: apply only compares it against values it just computed itself. A forged token can
at most cause a plan the user could have previewed anyway to be applied, and even then only on this host and only
if nothing changed. For this reason the token is deliberately unsigned and has no MAC (decision Q6).

### 3.5 Profile (`hub.bootstrap-profile` v1)

`{id, harnesses (in HARNESS_ORDER), runtimes, services, launch {enabled, maxDurationS}, escalation: never|explicit}`.
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
  | Codex | sha256 pinned in hub's signed manifest | sigstore bundle where upstream publishes one (`sigstore`) |
- `decideHarnessInstall(pin, {installed, floor, allowDowngrade})` applies the same downgrade policy as hubctl,
  with the pin's `minimumVersion` as the harness floor.
- Rollback: the journal class `harness` is backed up before it changes. Recovery restores the previous
  binary/version (`restore-backup`), or removes a fresh install (`remove-created`).
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

`enrollmentStatusFrom(credential, probe, now)` derives the state.

### 3.9 Transaction journal, ownership and lock

- The journal (`hub.transaction-journal`) records the plan digest, host fingerprint, consumed nonce, state, and one
  entry per change, numbered 1…n. Each entry has a class, a path, `before`/`after` file states (digest and mode
  only, **never contents**), a backup reference, and a status.
- Existing files of class file/config/service/artifact/harness/link are backed up before they change. Credentials are
  **never** backed up.
- `recoveryDecision(entry, now)`:

  | Entry | File now | Decision |
  |---|---|---|
  | undone / skipped / external | any | `nothing-to-do` |
  | pending | equals `before` | `nothing-to-do` (never started) |
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

### 3.11 Output envelope and exit codes

With `--json`, stdout carries exactly one `hub.bootstrap.result` envelope:
`{command, ok, data?, error?: {code, message, hint?}, warnings?}`. `ok: true` has no error; `ok: false` always has
one. The validator rejects any envelope containing a secret.

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
  - `change` is the exact structured edit: `merge {set[]}`, `register-mcp-server {harness, name}` (the command is
    implied, as in the action) or `write-file {asset, sha256, mode}`.
  - It is validated like an action: no command-shaped keys, no secrets, absolute normalized paths.
  - The refused action is not kept in the plan. A preview that still contains it is `inconsistent`.
- **Apply gate.** `previewApplicable` refuses while any blocker remains (`manual_edit_required`, exit 10) or any
  evidence failed (`evidence_failed`, exit 11). Once the user has made the edit in their dotfiles, a new preview
  sees the changed config, so it has a new digest and no blocker.

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
| T10 | Conflicting user edits / lossy config rewrite | `write-file` refuses conflicts; `merge-config` is lossless with a digest precondition; recovery keeps user edits | `Action rejects threat cases > silentOverwrite / lossyMerge`, `an intervening user edit is never overwritten` |
| T11 | Stale credential restored on rollback | Credential entries are cleared, never restored from a backup | `a stale credential is never restored`, `JOURNAL_INVALID credentialBackup` |
| T12 | Central (or a plan) asking for command execution | No command-capable action kind or field, at any depth or in the types; `register-mcp-server` implies its command | `Action union > no action kind declares…`, `…accepts a smuggled command…`, `the type system has no command-shaped field either`, `runCommandKind / shellKind / nestedCommandInConfig` |
| T13 | Silent privilege escalation / persistence | `escalation` exact per action; plan flags `requiresEscalation` and `activatesServices` must be exact; activation needs `confirm: "explicit"` | `systemPathWithoutEscalation / needlessEscalation / implicitActivation`, `PLAN_INVALID hiddenEscalation / hiddenActivation` |
| T14 | "Installed" mistaken for healthy (incl. container shims) | Presence ≠ health; readiness needs fresh, passing real probes | `harness readiness and adapters > …`, `DISCOVERY_INVALID verifiedWithoutProbes / verifiedByPresenceOnly` |
| T15 | Unsupported host half-configured | Explicit matrix; plans for unsupported targets refused | `supported platform matrix > …`, `PLAN_INVALID unsupportedTarget` |
| T16 | Executable name used as authority | `hub` / `hubctl` resolve to one surface | `executable argv contract > hub and hubctl are one command surface` |
| T17 | Shell injection through service units | argv word lists with absolute, single-line paths; embedded templates | `service argv is a word list, never a shell string` |
| T18 | Profile from a newer hubctl misread | Versioned profile; future versions refused; migrations explicit | `migrateProfile refuses…` |
| T19 | Unpinned or mismatched harness artifact (substituted URL, other version, other bytes, other hub release, unsupported target) | Harness pins in hub's **signed** manifest (transitive trust); `checkHarnessPin` needs a `VerifiedManifest`; exact version/target/source/size/sha256; mandatory digest check of the bytes | `harness pins in the signed hub manifest > …` (`unpinnedTarget`, `unpinnedVersion`, `otherHubRelease` → `unpinned_artifact`; `digestMismatch`, `sourceMismatch` → `integrity_mismatch`; tampered pin → `signature_invalid`), `the pinned digest is always checked first (never neither)` |
| T20 | Upstream evidence failing or skipped (bad GPG signature, failed notarization or sigstore) | A failed check rejects the artifact; evidence the pin lists must be attempted; the outcome is recorded in the preview and the install report | `failed evidence rejects the artifact…`, `HARNESS_PIN_INVALID evidenceSkipped`, `SetupPreview > failed evidence blocks apply` |
| T21 | Harness installer used as an exec channel (install scripts, post-install hooks) | `install-harness` has no installer/script/hook field; https only; plain file names | `install-harness rejects threat cases > installerScript / plainHttp / pathInFile`, smuggled-command tests (cover all 13 kinds) |
| T22 | Harness downgrade or failed install leaving a broken harness | Pin `minimumVersion` floor + explicit downgrade consent; `harness` journal class backed up; rollback restores the previous version | `harness downgrade policy > …`, `harness rollback > …` |
| T23 | Writing through a symlinked config into another repository | Refused; replaced by a structured, secret-free `ManualEdit`; apply blocked until resolved | `manual edits for symlinked configs > …`, `ManualEdit rejects threat cases`, `SetupPreview > a symlinked config blocks apply…` |

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
- Profiles: `PROFILE_SESSION_ONLY`, `PROFILE_LAUNCH_NODE`, `PROFILE_FULL_HARNESS`, `PROFILE_V0` (for the migration
  hook), and `PROFILE_INVALID`.
- Actions and plans: `ACTIONS` (one valid action per kind), `EXEC_SMUGGLING`, `ACTION_INVALID`,
  `PLAN_LAUNCH_NODE`, `PLAN_ELEVATED`, and `PLAN_INVALID`.
- Previews: `PREVIEW`, `PREVIEW_INVALID`.
- Artifacts: `MANIFEST_UNSIGNED`, `TRUST_ROOT_TEMPLATE`, `MANIFEST_INVALID`. Tests sign manifests with an
  **ephemeral** ed25519 key generated at test time; no key material is committed.
- Enrollment: `ENROLLMENT_VERIFIED`, `ENROLLMENT_UNCONFIGURED`, `ENROLLMENT_INVALID`.
- Journal and lock: `JOURNAL_APPLYING` (directory, config, credential and pending-file entries), `JOURNAL_INVALID`,
  `LOCK`.
- Readiness: `VERIFICATION_READY`, `VERIFICATION_INSTALLED_ONLY`.
- Pinned harness installs:
  - `HARNESS_PINS` (in `MANIFEST_UNSIGNED.harnesses`), and the install actions `ACTIONS["install-harness"]`
    (OpenCode), `INSTALL_CLAUDE` and `INSTALL_CODEX`.
  - `PLAN_HARNESS_INSTALL` (install → verify).
  - Threat cases: `HARNESS_ACTION_INVALID`, `HARNESS_PIN_INVALID`, `PLAN_HARNESS_INVALID`.
  - Rollback: `HARNESS_JOURNAL_ENTRY`.
- Symlinked configs: `SYMLINK`, `MANUAL_EDIT_MERGE`, `MANUAL_EDIT_MCP`, `MANUAL_EDIT_INVALID`.
- Envelopes: `ENVELOPE_OK`, `ENVELOPE_ERROR`, `ENVELOPE_INVALID`.

Note: `scripts/test-ci.sh` runs `packages/*/test/*.test.ts` (one directory level). Dependent tests belong in
`packages/cli/test/*.test.ts` and import from `./bootstrap/fixtures`.

## 7. Integration requirements (HBS-13)

This task does not edit these files. These are the edits needed to wire the contracts in.

- **I1 `packages/cli/src/cli.ts`**
  - Add the `machine` group (`enroll`, `status`) and the `setup` group (`discover`, `preview`, `apply`,
    `recover`, `ansible`).
  - Print `ResultEnvelope` under `--json`, and map failures through `exitFor`.
  - Keep `EXIT` 0–9 untouched (`BOOTSTRAP_EXIT` extends it).
  - Change the `readinessProblems` hint in node.ts from "enrol it with the OpenCode plugin's /hub dialog" to
    `hubctl machine enroll`.
  - Add `--escalate`, `--confirm-activation` and `--allow-downgrade` as explicit flags. They are never defaults.
  - `setup preview --json` prints the `SetupPreview`. Blockers are rendered for people as the exact edit and the
    file it belongs in (`resolvedPath`).
- **I2 `packages/cli/src/node.ts` and `spoke-services.ts`**
  - Replace `templateDir()` file reads with `EMBEDDED_ASSETS` (embed with Bun `import … with { type: "text" }`, or
    a generated module like `scripts/gen-web-entry.ts`). Today a standalone binary cannot find `scripts/`.
  - Replace `Program {execPath, entry}` and the `__RUNTIME__ __ENTRY__` placeholders with `ProgramLayout` +
    `serviceArgv`:
    - The plist renders one `<string>` per argv word.
    - The systemd unit renders `ExecStart=` from the words, using the existing `sd()` quoting.
  - `currentProgram()` becomes `programLayout({execPath: process.execPath, entry: realpath(argv[1])})`.
  - The templates in `scripts/*.plist` / `*.service` need an argv placeholder (e.g. `__ARGV__`) instead of
    `__RUNTIME__ __ENTRY__`.
- **I3 `packages/cli/src/main.ts`**
  - Add `machine enroll` (it polls until approved) to the commands that handle SIGINT/SIGTERM, so Ctrl-C cancels
    the device-code poll cleanly.
  - `delete process.env.BUN_BE_BUN` stays.
  - Standalone builds compile `main.ts` directly: `bun build --compile packages/cli/src/main.ts`.
- **I4 `src/config.ts`**
  - `normalize()` drops unknown keys, so `writeConfig(readConfig(...))` is lossy.
  - The `CredentialStore` implementation must merge into the raw JSON object (read raw, set
    `machineID`/`token`/`server`, write atomically with 0600) and preserve every other key. Alternatively, change
    `normalize`/`writeConfig` to carry unknown keys through.
  - `withServer` already drops credentials on a server change. Keep that rule: a credential belongs to its server.
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
