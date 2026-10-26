# Harnesses

A **harness** is a coding agent's program: its terminal app, server or IDE plugin. Each harness reaches the hub
through a **spoke**, a thin client that connects outbound to the hub's `/spoke/ws` with the machine's token, reports
the harness's sessions and events, and serves the hub's requests. The hub, its console, its API and the `hub` CLI
are the same for every harness; what differs is what each spoke can see and do, and the spoke says so in its hello.

| Harness | Spoke | How it sees the harness (evidence) | Start it with |
|---|---|---|---|
| [OpenCode](https://opencode.ai) | the `@huynle/hub` OpenCode plugin, in every OpenCode process | `native`: OpenCode's own events | `opencode plugin add @huynle/hub` ([README](../README.md#quick-start-opencode)) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | a per-user daemon fed by Claude Code's lifecycle hooks | `hooks` | `hub claude [claude args…]` |
| [Codex](https://github.com/openai/codex) | a per-user service attached to Codex's app-server | `rpc` (with confirmed turn ends) | `hub codex [codex args…]` |
| Presets (e.g. Aider, goose) | the preset spoke, driving the harness through a tmux pane | `screen` | `hub preset run <name>` |

Every spoke but OpenCode's is built on the spoke SDK's `HarnessSpoke` and passes the spoke conformance suite; to
connect another harness, see [spoke-sdk.md](spoke-sdk.md).

All of them need an **enrolled machine**: the machine token in `~/.config/hub/config.json` (or
`$HUB_SPOKE_CONFIG`), which the OpenCode plugin's `/hub` dialog writes. The other spokes only read it. Without it,
`hub claude` and `hub codex` run the harness as usual without the hub and say why.

## What each harness supports

The hub sends a spoke only the operations its hello announced. For OpenCode, the hello implies every core op;
other spokes announce each core op they serve (`turn`, `steer`, `interrupt`, `stop`, `permission`, `form`). Anything
else is refused before it reaches the spoke: the agent API answers `422 unsupported {feature, harness}`, the console
`409` with code `unsupported` (it also hides controls the spoke lacks), the CLI exits 7, and a launch fails with the
reason.

| | OpenCode | Claude Code | Codex | Preset |
|---|---|---|---|---|
| **Status** | busy, retry, idle from OpenCode; running shells | busy at a prompt, idle at Stop, waiting at a permission request; an Esc interrupt is inferred later | Codex's thread status and turn events | none: never idle; the session ends with its pane |
| **Timeline, summary, diff, models** | yes | no | no | no |
| **Messages (`deliver`)** | into the running turn (`steer`), a new turn (`turn`), after the turn (`queued`) or held while a question is open (`retained`) | `turn` when an idle session waits on its rewake hook; otherwise `queued`: the model reads it at the next tool boundary (PostToolUse) or the next prompt | busy: `steer` (Codex `turn/steer`), or `queued` with delivery `queue`; idle: `turn` (`turn/start`); `wake: false`: `queued` (`thread/inject_items`, no turn) | `queued` (pasted and submitted, never confirmed); `wake: false`: `retained` and pasted before the next turn |
| **Agent prompts (`hubPrompt`)** | yes | yes | yes | yes |
| **Permission** | yes | yes, while the PermissionRequest hook waits; races Claude Code's own dialog | yes, as one client of the thread; races the TUI | no |
| **Deny reasons (`permissionMessage`)** | yes | yes | no | no |
| **Stop** | the whole session tree | the running turn at its next tool hook; a waiting permission request is denied | interrupts the running turn | Ctrl-C |
| **Interrupt** | yes | hub-launched sessions only | yes | Ctrl-C |
| **Turn** | yes | hub-launched sessions only | yes | pasted; answered at once with outcome `timeout` (unconfirmed) |
| **Steer** | yes | no | yes | no |
| **Form (questions)** | yes | no | no | no |
| **Launches (`create`, `launch`)** | yes | yes, when the daemon finds the `claude` CLI | yes | no |
| **Session tokens in shells** | every shell | the Bash tool's shells, written once at SessionStart | kept by the spoke, not passed to Codex's shells | kept by the spoke, not passed to the pane |
| **Act tokens (act verbs)** | the OpenCode `hub` tool | the plugin's `hub` MCP server (the token stays in the daemon) | none | none |

Session IDs: hub session IDs are `ses_` + letters and digits. OpenCode's IDs already are; the other spokes map
their harness's native IDs reversibly: Claude Code `ses_cc<uuid hex>`, Codex `ses_cx<thread uuid hex>`, presets
`ses_pr<uuid hex>`.

## Evidence levels

The hello's `evidence` says how the spoke observes a session. The hub never treats a session as more certain than
its evidence allows; a level it does not know counts as `unknown`.

| Evidence | Spoke | The hub's idle | Delivery claims | Console |
|---|---|---|---|---|
| `native` | OpenCode | trusted | trusted | every control; no badge |
| `hooks` | Claude Code | trusted (hook events); a turn that ended by an *inferred* interruption counts as idle only 5 s later | `steer`/`turn` only when the spoke confirmed the message entered the session (`session.inbox.delivered`, origin `hub`); otherwise `queued` | "Hooks" badge; typed prompts labelled queued |
| `rpc` | Codex | trusted only when the spoke announces `turnEvents` (every turn end is the harness's own) | trusted | "RPC" badge |
| `screen` | presets | never idle | at most `queued` | "Screen" badge; prompts labelled queued |
| `unknown` | any other | never idle | at most `queued` | "Unknown" badge; prompts labelled queued |

Idle by real evidence is what ends a launch with `end: idle` and what lets the hub wake a session for a waiting
message; a preset session never qualifies.

## Claude Code

`hub claude [claude args…]` runs Claude Code with the hub's plugin loaded through `--plugin-dir`. It never edits
your `~/.claude` files or settings. On the first run it starts the per-user daemon (`hub claude-code daemon`) in the
background; the daemon is the spoke (`harness: "claude-code"`, kind `service`), connected to the hub with the
machine token, and listens on a Unix socket in a private directory.

```sh
hub claude                       # interactive, as usual
hub claude -p "fix the build"    # print mode works too
```

The plugin (written under `<hub state dir>/claude-code/plugins/`, by default `~/.local/state/hub/claude-code/`)
registers a hook for every event the spoke uses (SessionStart, UserPromptSubmit, Pre/PostToolUse,
PermissionRequest, Notification, Stop, SubagentStart/Stop, SessionEnd, …). Each hook runs the hook bridge (`hub
claude-code hook`), which hands the hook's input to the daemon and prints its answer. Tool names are put in the hub's
vocabulary for permissions: Bash → `shell`, Edit/Write/MultiEdit/NotebookEdit → `edit`, Read → `read`,
`mcp__<server>__<tool>` → `<server>_<tool>`.

| Setting (environment) | Default | |
|---|---|---|
| `HUB_CLAUDE_PERMISSION_WAIT` | `120` | seconds a permission request waits for the hub's answer; `0`: report only, Claude Code's dialog decides |
| `HUB_CLAUDE_REWAKE_TIMEOUT` | `3600` | seconds the rewake Stop hook may wait for a message for an idle session |
| `HUB_CLAUDE_BIN` | `claude` on PATH | the Claude Code executable |
| `HUB_CLAUDE_SOCKET` | `<state dir>/claude-code/daemon.sock` | another socket path (for a state dir too deep for a Unix socket path) |

**Messages.** A hub message reaches the model at the next hook that can carry context: in a running turn after the
next tool call (PostToolUse), else with the next prompt (UserPromptSubmit). An idle session is woken through an
asynchronous Stop hook (`asyncRewake`) that waits on the daemon: Claude Code starts a turn with the message framed as
a system notification, explicitly not user input. In `-p` without `--input-format stream-json` that hook would hold
the run open, so `hub claude -p` turns it off (`HUB_CLAUDE_REWAKE=off`).

**Launches.** When the daemon finds the `claude` CLI (and node.json does not withhold `claude-code`), it also
creates sessions for hub launches: each runs headless in the launch's workspace, which must be under the node's
`workspaceRoots` (`claude --plugin-dir … --session-id <uuid> -p --input-format stream-json --output-format
stream-json`). Only these sessions take hub turns (user messages on stdin) and interrupts (a control request). See
[launches.md](launches.md#harnesses).

**As a service.** `hub claude-code install [--dry-run]` writes a launchd agent
(`~/Library/LaunchAgents/io.github.huynle.hub-claude-code.plist`) or a systemd user unit
(`~/.config/systemd/user/hub-claude-code.service`) that runs the daemon, so launches can be placed on the machine
without a `hub claude` run first. Like `hub node install`, it **prints** the commands that load it and never runs
them. `hub claude-code uninstall [--dry-run]` removes it; `hub claude-code status` shows the unit file, the
enrolment (never the token), where the `claude` CLI is and the daemon's socket.

## Codex

`hub codex [codex args…]` runs Codex with its shared app-server daemon turned on for that run (`--enable
daemon_auto_start`, a flag, nothing written), so the TUI's threads live on the daemon where the hub's spoke can
attach. It starts the per-user spoke service (`hub codex-spoke serve`) in the background when none runs. It never
changes your `~/.codex` (or `$CODEX_HOME`).

The spoke (`harness: "codex"`, evidence `rpc`, `turnEvents`) is one client of Codex's app-server among others:

- **the shared daemon**: the spoke connects to `$CODEX_HOME/app-server-control/app-server-control.sock` when it
  answers (it never starts the daemon), lists the loaded threads and subscribes to each one;
- **its own app-server**: `codex app-server --listen stdio://`, started on the first create, for the threads the hub
  starts (launches). Stopping the spoke ends those threads.

| Setting (environment) | Default | |
|---|---|---|
| `HUB_CODEX_BIN` | `codex` on PATH | the Codex executable |
| `HUB_CODEX_DAEMON_SOCKET` | the daemon's socket under `CODEX_HOME` | another socket, or `off` for no daemon attach |
| `HUB_CODEX_CONFIG` | none | Codex config overrides for the spoke's own app-server, one `key=value` per line, passed as `-c` |

Approvals go to every client of a thread and the first answer wins; when the TUI (or another client) answered
first, the hub's answer is `gone`. Forms and MCP elicitations are left to the other clients.

`hub codex-spoke install [--dry-run]`, `uninstall [--dry-run]` and `status` manage it as a launchd agent
(`io.github.huynle.hub-codex-spoke`) or systemd user unit (`hub-codex-spoke.service`), printed, never loaded;
`status` also shows whether the service runs and the Codex daemon socket it attaches to. The service keeps a pid
file in `<hub state dir>/codex/spoke.pid` (one per user).

## Presets

A **preset** describes a harness that has no spoke of its own as data: the argv that starts it (never run through a
shell), an optional resume flag, and where its native session ID comes from. Delivery is always `paste` and evidence
always `screen`. Unknown fields are refused, and `opencode`, `claude-code` and `codex` are reserved names.

```json
{ "name": "aider", "command": ["aider"], "nativeID": { "source": "none" }, "delivery": "paste", "evidence": "screen" }
```

`nativeID.source` is `none` (cannot resume), `argv` with a `flag` (the hub passes a fresh ID, e.g. goose's
`--name`) or `screen` with a `pattern` (the first capture group, read off the screen).

```sh
hub preset list                       # the official presets: aider, goose
hub preset check ./my-agent.json      # validate a preset (exit 1 when invalid)
hub preset run aider [--cwd DIR] [--resume ID] [-- harness args…]
hub preset run aider --current        # in a new window of the tmux session you are in
hub preset run aider --no-hub         # only start the pane (no enrolment needed)
```

`hub preset run` starts the harness in a new pane on a **private** tmux server (`tmux -L hub-preset`, or
`--socket <name>`); your own tmux server is used only with `--current`. It stays connected to the hub until the pane
ends or Ctrl-C/SIGTERM (which leaves the harness running). The spoke pastes hub messages and turns into the pane,
sends Ctrl-C for stop and interrupt, and infers nothing from the screen except the native session ID and whether the
pane is still there.

## Launches on other harnesses

`hub launch --harness claude-code …` (or `codex`) starts a session of that harness. Placement needs a node that
offers the harness and the harness's service spoke connected on the same machine with `launch`. See
[launches.md](launches.md#harnesses).

## Known limits

- **Claude Code permission dialog race.** The PermissionRequest hook does not suppress Claude Code's own dialog: both
  run, and the first answer wins. When you answer in the terminal first, the hub's request is closed as answered
  elsewhere and a later hub answer is `gone`. When the hub does not answer in time, the dialog stays for you
  (interactive) or the tool is denied (`-p`).
- **Esc fires no Stop hook.** An interrupt in the Claude Code terminal is invisible until the next prompt or
  notification; the spoke then ends the turn as an *inferred* interruption, and the hub waits 5 s before trusting
  idle after one.
- **Claude Code permission modes that approve on their own** (auto mode, `bypassPermissions`, `acceptEdits` for
  edits) fire no PermissionRequest: the hub sees no request and cannot answer one.
- **Features are per connection, not per session.** A Claude Code daemon that can launch announces `turn` and
  `interrupt` for all its sessions; a terminal session (started with `hub claude`) refuses them with an error
  saying to send a message instead.
- **Claude Code session tokens** are written once, at SessionStart (Claude Code reads its env file only then); a
  session running longer than the token's 24 h gets `token_expired` in its shells. `--bare` turns off Claude Code's
  hooks and plugins, so such a session never reaches the hub (`hub claude` warns).
- **Codex: a hub reject ends the turn.** Codex treats a declined approval as the end of the turn, which ends
  `interrupted` rather than continuing without the command.
- **Codex: no hooks spoke.** Codex hooks need a trust entry in your `~/.codex/config.toml`, which the hub never
  writes, and they run inside the daemon without per-session environment; only the app-server spoke is provided.
- **Codex launches** do not check the directory against the node's workspace roots themselves (the node prepared
  it there); the spoke only checks that it is an existing absolute directory.
- **Presets** never confirm a delivery or a turn, never count as idle, and cannot answer permissions or questions.
- The Claude Code daemon and the Codex service have no restart recovery for sessions the hub launched: stopping them
  ends those sessions.

## Security and threat model

The hub can drive sessions that run tools, so each spoke keeps to the same rules:

- **The boundary is your user account.** The Claude Code daemon listens on a Unix socket (mode 0600) in a private
  directory (0700, refused when it is a symlink or someone else's), and the Codex daemon's socket is Codex's own
  (0600 in a 0700 directory, no authentication). Any process running as you can talk to them, so it can forge hook
  events, answer permissions as the hook would, or use a session's tools through the daemon. Other users cannot. Run
  untrusted code as another user or in a sandbox ([sandboxed launches](launches.md#sandboxed-launches-openshell-runtime)).
- **The hook bridge fails open.** No daemon, a late or bad answer, any error: the hook exits 0 without output, as if
  it were not there. Claude Code then behaves as without the hub (its own dialog decides permissions). A hub or daemon
  that does not answer never approves anything.
- **Tokens.** The machine token is read from config.json and sent only as the WebSocket's bearer; it is never
  logged. Session tokens go only where shells get them: for Claude Code into the session's env file (mode 0600,
  `CLAUDE_ENV_FILE`), which the Bash tool reads. Act tokens never go into any environment: Claude Code's act verbs go
  through the plugin's MCP pipe to the daemon, which holds the token in memory. The conformance suite checks that no
  token appears in a spoke's output, logs or frames.
- **Your harness configuration stays yours.** `hub claude` loads its hooks with `--plugin-dir`; `hub codex` passes
  flags and `-c` overrides. Neither writes `~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
- **Presets are data.** A preset's command is an argv list with shell syntax refused; nothing is run through a shell.
  The preset spoke uses its own tmux server unless you pass `--current`.
- **Hub-origin input is marked.** Messages delivered into Claude Code arrive as additional context or as a system
  notification, never as your prompt; agent prompts (`hubPrompt`) carry a provenance header naming the sender and the
  grant.
- **Services are never loaded for you.** `install` writes a unit file and prints the `launchctl` / `systemctl`
  commands.
- **Live tests are opt-in and isolated.** `HUB_IT_CLAUDE=1` and `HUB_IT_CODEX=1` run the real CLIs against a local
  stub model, with a throwaway `HOME`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and a deny-all proxy for every other
  connection (both CLIs try to reach the internet even with a local base URL). Without the variables they are
  skipped.
