// Right rail of a session (bottom sheet on phones): Server, Context, MCP and Changes from
// GET /api/sessions/:id/summary; a changed file opens the diff viewer over the transcript.
import { For, Show, createResource, createSignal } from "solid-js"
import { parsePatch } from "../lib/diff"
import type { Found } from "../lib/store"
import { enc, getJSON, sessionPath } from "./api"
import { Icon, IconButton, SOURCE_LABEL, basename } from "./ui"

export interface Summary {
  directory: string
  branch?: string
  context?: { used: number; limit?: number; percent?: number; model?: string }
  mcp?: Array<{ name: string; status: string; error?: string }>
  changes?: { files: Array<{ file: string; status: string; additions: number; deletions: number }>; additions: number; deletions: number }
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
  return (
    <aside class="rail" aria-label="Session details">
      <div class="rail-head">
        <span class="rail-title">Details</span>
        <IconButton icon="close" label="Close details" onClick={props.onClose} />
      </div>
      <section class="rail-card" aria-label="Server">
        <h3>Server</h3>
        <Show when={props.found} fallback={<p class="muted small">Not reported by any connected machine.</p>}>
          {(f) => (
            <dl class="kv">
              <dt>Machine</dt>
              <dd>
                <span class={`online-dot${f().machine.online ? " on" : ""}`} aria-hidden="true" />
                {f().machine.name} <span class="muted">· {f().machine.online ? "online" : "offline"}</span>
              </dd>
              <dt>Folder</dt>
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
      </section>
      <section class="rail-card" aria-label="Context">
        <h3>Context</h3>
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
      </section>
      <section class="rail-card" aria-label="MCP servers">
        <h3>MCP</h3>
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
      </section>
      <section class="rail-card" aria-label="Changes" id="rail-changes">
        <h3>
          Changes
          <Show when={props.summary?.changes}>
            {(c) => (
              <span class="diffstat">
                <span class="add">+{c().additions}</span> <span class="del">−{c().deletions}</span>
              </span>
            )}
          </Show>
        </h3>
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
            </Show>
          )}
        </Show>
      </section>
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
