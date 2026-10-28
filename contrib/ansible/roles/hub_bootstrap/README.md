# hub_bootstrap (optional Ansible role)

Bootstraps a machine into Hub with Ansible instead of running `hubctl setup` by hand. **Ansible is optional**:
the direct path (`hubctl setup preview`, then `hubctl setup apply`) does the same thing, and this role is a thin
wrapper around it. The role reimplements nothing:

1. It downloads the hubctl release manifest and the hubctl binary for the host's target into a cache, and refuses
   the binary unless its sha256 equals the digest pinned in the rendered vars (which come from a manifest whose
   signature was verified when the vars were rendered). The downloaded manifest must carry the same release,
   security floor, hubctl digest and harness pins.
2. It runs that hubctl: `hubctl setup preview`, `hubctl setup apply` and `hubctl setup verify`, with the same
   canonical profile, the same manifest (`--manifest`, whose signature hubctl checks again with its embedded trust
   root) and the same consent flags as the direct path. Installing hubctl itself, harness installs, config merges,
   service units and activation are typed plan actions that hubctl applies and journals. The role has no shell,
   package, service or privilege tasks.

**Enrollment is a separate, explicit step.** The role never enrolls a machine. It refuses a plan that contains
`enroll-machine`, and only reports `hubctl machine status`. Enroll the machine on the host yourself with
`hubctl machine enroll`; that is the device-code flow, which a person approves.

The vars carry **no secrets** and never will. They hold the profile, release pins and consent flags only. The
renderer scans its output and refuses anything credential-shaped. The machine credential only ever lives in
hubctl's credential store on the host, and provider and harness logins stay with the user.

## Usage

```sh
# 1. Render the vars (on the controller). From a profile:
hubctl setup ansible --profile profile.json --release-url https://github.com/huynle/hub/releases/download/v0.8.0 \
  > hub-bootstrap-vars.yml
#    ...or bound to one previewed plan for one host (the play then applies only that plan):
hubctl setup ansible --profile profile.json --plan preview.json --release-url … --confirm-activation > vars.yml

# 2. Check mode: stage the pinned hubctl and preview only. Nothing else is written.
ansible-playbook -i inventory contrib/ansible/hub-bootstrap.yml -e @hub-bootstrap-vars.yml --check --diff

# 3. Apply and verify.
ansible-playbook -i inventory contrib/ansible/hub-bootstrap.yml -e @hub-bootstrap-vars.yml

# 4. Enroll, on the host, as a separate step.
hubctl machine enroll
```

## Behaviour

| Mode | What runs |
|---|---|
| `--check` | Stage the pinned hubctl and manifest into `hub_bootstrap_cache_dir` (content-checked, not on PATH; set `hub_bootstrap_stage_in_check_mode: false` to skip). Then `setup preview` (read-only, without `--out`). The play reports `changed` when the plan has changes, and fails on the same refusals as a real run. |
| `--diff` | Also prints each planned action's summary and every manual edit (`resolvedPath` + the exact structured change). |
| normal | Preview (kept in `hub_bootstrap_state_dir/preview.json`), then `setup apply`, but only if the plan has changes. Then `setup verify` and `machine status`. |
| second run | A converged host previews no changes, so apply does not run, and nothing reports `changed`. |

The play refuses, before apply, when any of these holds:

- The plan differs from the one the vars were rendered from (`hub_bootstrap_expected_plan`).
- The profile's canonical JSON does not hash to `hub_bootstrap_profile_digest`.
- The preview has manual-edit blockers: symlinked configs, which you edit in your dotfiles.
- The plan enrolls the machine.
- The plan is elevated or activates services, and the matching consent var is off.

hubctl enforces the same rules again at apply time.

## Variables

Rendered by `hubctl setup ansible`. `meta/argument_specs.yml` validates them.

| Var | Meaning |
|---|---|
| `hub_bootstrap_vars_schema`, `hub_bootstrap_vars_version` | `hub.ansible-vars`, `1` |
| `hub_bootstrap_release`, `hub_bootstrap_channel`, `hub_bootstrap_minimum_version` | the verified manifest's release, channel and security floor |
| `hub_bootstrap_manifest_url` | `<release>/hubctl-manifest.json` |
| `hub_bootstrap_artifacts` | per target: `{url, file, size, sha256}` of hubctl |
| `hub_bootstrap_harness_pins` | `[{harness, version, target, sha256}]` from the manifest |
| `hub_bootstrap_profile`, `hub_bootstrap_profile_digest` | the `hub.bootstrap-profile` document and the digest of its canonical JSON |
| `hub_bootstrap_expected_plan` | `null`, or `{planDigest, hostFingerprint, snapshotDigest, target}` of the previewed plan |
| `hub_bootstrap_escalate` / `_confirm_activation` / `_allow_downgrade` | consent, default `false`, passed as `--escalate` / `--confirm-activation` / `--allow-downgrade` |
| `hub_bootstrap_require_ready` | fail when `setup verify` is not ready (default `true`) |
| `hub_bootstrap_cache_dir`, `hub_bootstrap_state_dir`, `hub_bootstrap_stage_in_check_mode` | local paths, defaults in `defaults/main.yml` |

## The hubctl interface this role expects

Some of these commands and flags are not wired into the CLI yet. This is the interface the role relies on.
`packages/cli/src/bootstrap/ansible/render.ts` (`directCommands`) produces the same argv.

```text
hubctl setup preview --profile <file|-> --manifest <file> [--out <file>] --json
    Profile from the file, or from stdin with "-". Verifies the manifest with the embedded trust root (exit 11 on
    failure). Prints one hub.bootstrap.result envelope whose data is the SetupPreview. With --out, also writes the
    SetupPreview (with its token) to <file>, mode 0600. Read-only otherwise.
hubctl setup apply --preview <file> --manifest <file> [--escalate] [--confirm-activation] [--allow-downgrade] --json
    Revalidates the preview (rediscover, re-plan, compare), then applies. The hubctl artifact the plan installs is
    the running, digest-checked binary. Exit codes as in BOOTSTRAP_EXIT.
hubctl setup verify --profile <file|-> --json
    Runs the real probes for the profile's harnesses. Exit 0 when ready, 15 (harness_not_ready) otherwise.
hubctl machine status --json
    Envelope data: EnrollmentStatus (state unconfigured | configured | verified | revoked | offline).
hubctl setup ansible --profile <file> [--plan <file>] --release-url <https-url> [--escalate]
    [--confirm-activation] [--allow-downgrade] [--no-require-ready]
    Verifies the release manifest, then prints renderYAML(renderRoleVars(...)). Errors use the envelope codes.
```

## Tests

- `packages/cli/test/bootstrap-ansible.test.ts`: the renderer. It covers pins, consent, enrollment, plan binding,
  the YAML round trip and the secret scan.
- `packages/cli/test/bootstrap-ansible-role.test.ts`: a static check of this role. It covers modules, argv,
  check mode and canonical profile JSON, and runs `ansible-playbook --syntax-check` when Ansible is installed.
