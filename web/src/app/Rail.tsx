// Right rail of a session (bottom sheet on phones): Environment, Context, Connectors (MCP) and Changes from
// GET /api/sessions/:id/summary; a changed file opens the diff viewer over the transcript. Each card collapses
// from its header (chevron); collapsed cards are remembered per device.
import { For, Show, createResource, createSignal, type JSX } from "solid-js"
import { loadCollapsed, toggleCollapsed } from "../core/environment-core"
import { hub } from "./hub"
import { parsePatch } from "../lib/diff"
import type { Found } from "../lib/store"
import { enc, getJSON, sessionPath } from "./api"
import { Icon, IconButton, SOURCE_LABEL, basename, now } from "./ui"
import { jobLabel, retryText, treeJobs } from "../core/jobs-core"

export interface Summary {
  directory: string
  branch?: string
  context?: { used: number; limit?: number; percent?: number; model?: string }
  mcp?: Array<{ name: string; status: string; error?: string }>
  changes?: {
    files: Array<{ file: string; status: string; additions: number; deletions: number }>
    additions: number
    deletions: number
    /** All changed files, listed or not (absent from older spokes). */
    totalFiles?: number
    /** The spoke listed only the most-changed files. */
    truncated?: boolean
  }
}

/** How many changed files the spoke did not list (0 when it listed them all). */
export const unlistedFiles = (c: NonNullable<Summary["changes"]>) => (c.truncated && c.totalFiles ? Math.max(0, c.totalFiles - c.files.length) : 0)

const [collapsed, setCollapsed] = createSignal(loadCollapsed(localStorage))

/** A rail card whose header (title, chevron) collapses it. */
function Card(props: { id: string; title: string; label?: string; extra?: JSX.Element; children: JSX.Element; domID?: string }) {
  const open = () => !collapsed().has(props.id)
  return (
    <section class={`rail-card${open() ? "" : " collapsed"}`} aria-label={props.label ?? props.title} id={props.domID} data-card={props.id}>
      <h3>
        <button type="button" class="card-toggle" aria-expanded={open()} onClick={() => setCollapsed(toggleCollapsed(localStorage, props.id))}>
          <Icon name="chevron" class="card-chevron" />
          <span>{props.title}</span>
        </button>
        {props.extra}
      </h3>
      <Show when={open()}>{props.children}</Show>
    </section>
  )
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))

export function Rail(props: {
  found: Found | undefined
  summary: Summary | undefined
  summaryError: string
  loading: boolean
  onFile: (file: string) => void
  onClose: () => void
}) {
  const s = () => props.found?.session
  const source = () => (s()?.open ? (s()?.terminal?.source === "herdr" ? "herdr" : "tui") : "background")
  const jobs = () => treeJobs(s()?.status, now())
  const running = () => jobs().filter((j) => j.status === "running").length
  const retry = () => (s()?.state === "working" || s()?.status?.some((x) => x.state === "working") ? retryText(s()?.status, s()?.id) : undefined)
  const connectors = () => {
    const mcp = props.summary?.mcp
    return mcp?.length ? `Connectors · ${mcp.filter((m) => m.status === "connected").length} connected` : "Connectors"
  }
  return (
    <aside class="rail" aria-label="Session details">
      <div class="rail-head">
        <span class="rail-title">Details</span>
        <IconButton icon="close" label="Close details" onClick={props.onClose} />
      </div>
      <Card id="environment" title="Environment">
        <Show when={props.found} fallback={<p class="muted small">{hub.machines ? "Not reported by any connected machine." : "Loading…"}</p>}>
          {(f) => (
            <dl class="kv">
              <dt>Machine</dt>
              <dd>
                <span class={`online-dot${f().machine.online && hub.connection === "live" ? " on" : ""}`} aria-hidden="true" />
                {f().machine.name} <span class="muted">· {hub.connection !== "live" ? "Connecting" : f().machine.online ? "online" : "offline"}</span>
              </dd>
              <dt>Project</dt>
              <dd class="mono" title={props.summary?.directory ?? f().session.directory}>
                {basename(props.summary?.directory ?? f().session.directory)}
              </dd>
              <dt>Branch</dt>
              <dd class="mono">{props.summary?.branch ?? <span class="muted">{props.loading ? "…" : "—"}</span>}</dd>
              <dt>Open in</dt>
              <dd>
                {SOURCE_LABEL[source()]}
                {s()?.terminal?.workspace ? ` · ${s()!.terminal!.workspace}` : ""}
              </dd>
            </dl>
          )}
        </Show>
      </Card>
      <Show when={jobs().length || retry()}>
        <Card id="jobs" title={`Jobs${running() ? ` · ${running()} running` : ""}`} label="Background jobs">
          <Show when={retry()}>{(text) => <p class="small retry-note">{text()}</p>}</Show>
          <ul class="job-list">
            <For each={jobs()}>
              {(job) => (
                <li class={`job ${job.status}`} title={job.command ?? job.id}>
                  <span class={`job-dot ${job.status === "running" ? "on" : job.exit ? "bad" : ""}`} aria-hidden="true" />
                  <span class="job-command mono">{job.command ?? job.id}</span>
                  <span class="muted small">
                    {jobLabel(job, now())}
                    {job.sessionID !== s()?.id && job.sessionTitle ? ` · ${job.sessionTitle}` : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Card>
      </Show>
      <Card id="context" title="Context">
        <Show when={props.summary?.context} fallback={<p class="muted small">{props.loading ? "Loading…" : "No usage reported yet."}</p>}>
          {(c) => (
            <>
              <div class="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c().percent ?? 0} aria-label="Context used">
                <span style={{ width: `${c().percent ?? 0}%` }} class={(c().percent ?? 0) > 80 ? "hot" : ""} />
              </div>
              <p class="small">
                <strong>{c().percent !== undefined ? `${c().percent}%` : tokens(c().used)}</strong>
                <span class="muted">
                  {" "}
                  {c().limit ? `${tokens(c().used)} / ${tokens(c().limit!)} tokens` : "tokens"}
                  {c().model ? ` · ${c().model}` : ""}
                </span>
              </p>
            </>
          )}
        </Show>
      </Card>
      <Card id="mcp" title={connectors()} label="MCP servers">
        <Show when={props.summary?.mcp?.length} fallback={<p class="muted small">{props.loading ? "Loading…" : "No MCP servers."}</p>}>
          <ul class="mcp-list">
            <For each={props.summary!.mcp}>
              {(m) => (
                <li title={m.error ?? m.status}>
                  <span class={`mcp-dot ${m.status}`} aria-hidden="true" />
                  <span class="mcp-name">{m.name}</span>
                  <span class="muted small">{m.status.replace("_", " ")}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Card>
      <Card
        id="changes"
        title="Changes"
        domID="rail-changes"
        extra={
          <Show when={props.summary?.changes}>
            {(c) => (
              <span class="diffstat">
                <span class="add">+{c().additions}</span> <span class="del">−{c().deletions}</span>
              </span>
            )}
          </Show>
        }
      >
        <Show
          when={props.summary?.changes}
          fallback={
            <p class="muted small">
              {props.loading ? "Loading…" : props.summaryError || "No working-tree changes reported (not a git repository, or OpenCode is still warming up)."}
            </p>
          }
        >
          {(c) => (
            <Show when={c().files.length} fallback={<p class="muted small">No changes.</p>}>
              <ul class="file-list">
                <For each={c().files}>
                  {(f) => (
                    <li>
                      <button type="button" class="file" onClick={() => props.onFile(f.file)} title={f.file}>
                        <span class={`file-status ${f.status}`}>{f.status[0]!.toUpperCase()}</span>
                        <span class="file-name">{f.file}</span>
                        <span class="diffstat small">
                          <span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={unlistedFiles(c())}>
                {(n) => <p class="muted small more-files">+{n()} more {n() === 1 ? "file" : "files"} (only the most-changed files are listed)</p>}
              </Show>
            </Show>
          )}
        </Show>
      </Card>
    </aside>
  )
}

export function DiffPanel(props: { sessionID: string; file: string; files: string[]; onFile: (file: string) => void; onClose: () => void }) {
  const [patch] = createResource(
    () => props.file,
    async (file) => getJSON<{ file: string; status: string; additions: number; deletions: number; patch: string; truncated: boolean }>(`${sessionPath(props.sessionID)}/diff?file=${enc(file)}`),
  )
  const [wrap, setWrap] = createSignal(false)
  return (
    <section class="diff-panel" aria-label={`Changes in ${props.file}`}>
      <header class="diff-head">
        <Icon name="diff" />
        <select aria-label="Changed file" value={props.file} onChange={(e) => props.onFile(e.currentTarget.value)}>
          <For each={props.files}>{(f) => <option value={f}>{f}</option>}</For>
        </select>
        <Show when={patch()}>
          {(p) => (
            <span class="diffstat">
              <span class="add">+{p().additions}</span> <span class="del">−{p().deletions}</span>
            </span>
          )}
        </Show>
        <label class="small muted wrap-toggle">
          <input type="checkbox" checked={wrap()} onChange={(e) => setWrap(e.currentTarget.checked)} /> Wrap
        </label>
        <IconButton icon="close" label="Close diff" onClick={props.onClose} />
      </header>
      <div class={`diff-body${wrap() ? " wrap" : ""}`}>
        <Show when={!patch.loading} fallback={<p class="muted small pad">Loading diff…</p>}>
          <Show when={!patch.error} fallback={<p class="muted small pad">{(patch.error as Error)?.message === "No changes for that file" ? "This file has no changes any more." : `Could not load the diff: ${(patch.error as Error)?.message}`}</p>}>
            <Show when={patch()?.patch} fallback={<p class="muted small pad">No textual changes (binary file, or a rename).</p>}>
              <table class="diff">
                <tbody>
                  <For each={parsePatch(patch()!.patch).filter((l) => l.type !== "meta")}>
                    {(l) => (
                      <tr class={l.type}>
                        <td class="ln">{l.oldNo ?? ""}</td>
                        <td class="ln">{l.newNo ?? ""}</td>
                        <td class="code-line">
                          <span class="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={patch()!.truncated}>
                <p class="muted small pad">The diff is too large to show completely (512 KB).</p>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}
