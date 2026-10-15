# Session view: open sessions first (0.4.0) — contract

The phone used to list every stored session (up to 500, any age). Users think in terms of what is open
in their terminals. 0.4.0 lists those first.

## What the spoke reports

- **Open sessions** (`SessionInfo.open: true`, `terminal: {...}`):
  - **Herdr** (when the `herdr` CLI is installed and its server is running): the service spoke (or, with
    no service spoke on the machine, the first standalone) runs `herdr agent list` every 5 s (and
    `herdr workspace list` every 30 s), with a 3 s timeout, and marks every `agent == "opencode"` pane's
    `agent_session.value` as open with `terminal = {source:"herdr", workspaceID, workspace (label),
    title (terminal_title_stripped minus a leading "OC | "), status (agent_status)}`. It sends a
    `terminals` frame with the Herdr workspaces (id, label, pane directories by frequency).
    Errors (no herdr, server down) are silent: no Herdr data.
  - **TUI presence** (always): the TUI plugin reports the session it is showing (route) and its open
    tabs to the server-side spoke via RPC `hub.presence({sessionIDs})` on change and every 15 s; the
    spoke treats a session as open while any TUI reported it within 45 s (`terminal.source: "tui"`).
    Herdr wins when both apply.
- **History window**: other root sessions only from the last `list.days` days (default 30), at most
  `list.max` (default 100), newest first. Config `~/.config/opencode-hub/config.json`:
  `"list": {"days": 30, "max": 100}` (days 1–365, max 1–500).
- **Always included** regardless of the window: open sessions, running or blocked sessions, sessions in
  conversation mode, voice-enabled sessions in `session` mode, and sessions the hub asks to keep
  (pinned): the hub sends `{op: "keep", sessionIDs}` — not in this version; pins older than the window
  simply drop out of history.

## Hub

- Passes `open` and `terminal` through on every session object; keeps the latest `terminals` frame per
  machine and exposes it as `machine.terminals` in `GET /api/machines` and SSE `catalog`.
- Per-user view preferences, persisted on the user record (pairing mode: user `local`):
  `prefs: {hiddenSessions: string[], hiddenWorkspaces: string[], pinnedSessions: string[],
  pinnedWorkspaces: string[]}` (each max 500 entries, strings ≤ 4096). Workspace keys are the phone's
  group keys (Herdr `herdr:<workspaceID>` or a folder path).
  - `GET /api/prefs/view` → prefs; `PUT /api/prefs/view` partial replace of any list (cookie + Origin);
    SSE `{type:"prefs", prefs}` to the user's other devices.
- `POST /api/machines/:machineID/sessions {directory, title?, herdrWorkspace?}` → 201
  `{sessionID, openedIn?: "herdr"}`. The spoke validates the directory as before (a reported session
  directory, workspace root, or a directory of a Herdr workspace pane), creates the session, and with
  `herdrWorkspace` runs `herdr tab create --workspace <id> --cwd <directory>` (check the real CLI) then
  `herdr agent start <title> --kind opencode --pane <new pane> -- --session <sessionID>`. If Herdr
  fails, the session still exists: return 201 without `openedIn` plus a `warning`.

## Phone

- Home tabs: **Open** (default) · **Recent** · **Hidden**.
  - **Open**: "Needs you" strip, then open sessions grouped by Herdr workspace label (like Herdr's
    sidebar), or by project folder for TUI-only/standalone sessions; each row: status dot (working /
    blocked / idle), title, short folder, now-line.
  - **Recent**: everything else the spoke sent (history window), grouped by workspace, with search and
    the existing filter chips.
  - **Hidden**: hidden sessions and workspaces with Unhide.
- Row and group menus: Pin / Unpin, Hide / Unhide (synced via prefs). Pins float to the top. Local pins
  from 0.3 are migrated into prefs once.
- **New session**: a "+" on each workspace group and in the header: choose workspace (Herdr workspaces
  first, with their directories; or a folder), optional title, "Open in Herdr" (default on when the
  machine has Herdr) → POST → navigate to the session and offer conversation mode.
