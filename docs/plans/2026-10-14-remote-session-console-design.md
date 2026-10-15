# Remote session console

## Goal

Turn the hub into a remote OpenCode session console where every owned session can be inspected and
controlled from desktop or phone. Voice is an optional interaction mode, not the access boundary.

## Access model

Every root session reported by a connected machine is remotely accessible to its owner, whether Voice is
on or off. Inspect/control access includes timeline history and live status, typed turns, busy-session
steering, whole-tree interruption, and permission/form responses. Voice-enabled access additionally
provides microphone input, conversation mode, spoken replies and voice notifications.

Cross-user sessions remain indistinguishable from missing sessions (404). Full tool details remain lazy,
authorized and non-persistent in the hub.

## Control behavior

- Idle typed submit starts a normal turn and the primary action reads **Send**.
- Busy typed submit automatically uses steer delivery and the action reads **Steer**.
- A visible **Stop** action interrupts the root and every active descendant. It is idempotent and tolerates
  descendants settling while the stop is in progress.
- Permissions and forms are actionable regardless of Voice state.
- Offline sessions remain inspectable from available history but controls explain that the machine is
  disconnected.

## Visual direction

Use the supplied Claude Code screenshots as the structural and density reference while preserving
OpenCode Voice branding:

- Near-black layered surfaces, muted one-pixel dividers, restrained status color, generous conversation
  whitespace and compact controls.
- Desktop: persistent narrow left sidebar; minimal top toolbar; centered readable conversation column;
  low-profile composer/footer.
- Mobile: full-height sidebar drawer and project/workspace bottom sheet.
- Sidebar: search, new session, workspace/project sections, compact sessions with status dots, overflow
  actions, Needs-you/running first, then open, then recent.
- Composer: one primary input, Send/Steer state, Stop while busy, optional Voice toggle, compact Voice and
  Worker model controls, secondary controls in a footer.

Do not copy Claude branding or unrelated controls such as PR creation. The result should feel like a
purpose-built OpenCode console.

## Desktop home

Desktop defaults to a sortable/filterable All Sessions table across connected machines. Columns: status,
title, workspace/project, machine, open source, Voice state, last activity and current activity. Search
covers title, project, directory and machine. Filters cover status, machine, project, open/closed and
Voice on/off. Rows expose Open, Voice toggle, Pin, Hide, Stop and Steer actions. Mobile uses the compact
session list rather than a squeezed table.

## Protocol changes

- Unexposed reported roots and their descendants participate in status boards and event forwarding.
- Session history, timeline details, turn, steer, interrupt and permission/form replies no longer require
  `exposed:true`; conversation and speech operations still do.
- Add a whole-tree stop operation or implement it in the spoke by resolving active descendants and
  interrupting descendants before the root.
- Catalog/session views clearly separate `connected`, `controllable` and `voiceEnabled` semantics instead
  of overloading `exposed`.

## Error and race behavior

- A disappearing session returns to the list with a notice.
- Rejected steer preserves the draft.
- Stop handles children that finish concurrently and returns success for an already-idle tree.
- Permission requests resolved elsewhere disappear through synchronized state.
- Navigation/filter updates preserve selected session and scroll position where possible.

## Verification

- Ownership and 404 isolation for inspect/control routes.
- Idle Send vs busy auto-Steer.
- Whole-tree Stop ordering, idempotency and races.
- Permission/form responses while Voice is off.
- Status/event forwarding for Voice-off roots and descendants.
- Pure UI tests for table sorting/filtering, sidebar ordering, drawer state and composer controls.
- Existing Voice, model picker, timeline and multi-user tests remain green.
- Full CI/typecheck, private OpenCode smoke test and responsive browser checks.
