// Renders lib/markdown's tree as elements (never innerHTML). Index (not For) keeps each block's and each inline
// node's elements in place while a reply streams in: a growing paragraph updates its text instead of being rebuilt.
// Code blocks: a language label, copy and wrap buttons, and highlighting from lib/highlight, loaded on the first
// code block (its own chunk).
import { Index, Match, Show, Switch, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { parseMarkdown, type Inline as InlineNode, type MdBlock } from "../lib/markdown"
import type { Token } from "../lib/highlight"

type Highlighter = (code: string, lang: string) => Token[]
const [highlighter, setHighlighter] = createSignal<{ run: Highlighter; languageOf: (tag: string) => string | undefined }>()
let loading = false
function loadHighlighter(): void {
  if (loading) return
  loading = true
  import("../lib/highlight").then(
    (m) => setHighlighter({ run: m.highlight, languageOf: m.languageOf }),
    () => (loading = false),
  )
}
/** Longer blocks are shown plain: tokenizing them would stall the page. */
const HIGHLIGHT_MAX = 64 * 1024

function Inline(props: { nodes: InlineNode[] }): JSX.Element {
  return (
    <Index each={props.nodes}>
      {(node) => (
        <Switch>
          <Match when={node().type === "text" && (node() as { text: string })}>{(n) => <>{n().text}</>}</Match>
          <Match when={node().type === "br"}>
            <br />
          </Match>
          <Match when={node().type === "code" && (node() as { text: string })}>{(n) => <code class="inline-code">{n().text}</code>}</Match>
          <Match when={node().type === "link" && (node() as Extract<InlineNode, { type: "link" }>)}>
            {(n) => (
              <a href={n().href} target={n().href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
                <Inline nodes={n().children} />
              </a>
            )}
          </Match>
          <Match when={node().type === "image" && (node() as Extract<InlineNode, { type: "image" }>)}>
            {(n) => (
              // Images are never loaded (remote content in replies): a link to them, named by the alt text.
              <Show when={n().href} fallback={<span class="md-image">{n().alt || "image"}</span>}>
                <a class="md-image" href={n().href} target="_blank" rel="noopener noreferrer" title="Image (opens in a new tab)">
                  {n().alt || "image"}
                </a>
              </Show>
            )}
          </Match>
          <Match when={"children" in node() && (node() as Extract<InlineNode, { children: InlineNode[] }>)}>
            {(n) => (
              <Dynamic component={({ strong: "strong", em: "em", del: "del", mark: "mark" } as const)[n().type as "strong"] ?? "span"}>
                <Inline nodes={n().children} />
              </Dynamic>
            )}
          </Match>
        </Switch>
      )}
    </Index>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Insecure origins (plain http on the LAN) have no async clipboard.
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

function CodeBlock(props: { lang: string; text: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  const [wrap, setWrap] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  loadHighlighter()
  const tokens = createMemo((): Token[] => {
    const h = highlighter()
    if (!h || !props.lang || props.text.length > HIGHLIGHT_MAX || !h.languageOf(props.lang)) return [{ text: props.text }]
    return h.run(props.text, props.lang)
  })
  const label = () => props.lang || "text"
  return (
    <div class={`code-block${wrap() ? " wrap" : ""}`}>
      <div class="code-head">
        <span class="code-lang">{label()}</span>
        <button type="button" class="code-btn" aria-pressed={wrap()} onClick={() => setWrap(!wrap())} title={wrap() ? "Scroll long lines" : "Wrap long lines"}>
          {wrap() ? "No wrap" : "Wrap"}
        </button>
        <button
          type="button"
          class="code-btn"
          aria-label={copied() ? "Copied" : `Copy ${label()} code`}
          onClick={async () => {
            if (!(await copyText(props.text))) return
            setCopied(true)
            clearTimeout(timer)
            timer = setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>
      <pre class="code" data-lang={props.lang || undefined}>
        <code>
          <Index each={tokens()}>
            {(t) => (
              <Show when={t().kind} fallback={t().text}>
                <span class={`tok-${t().kind}`}>{t().text}</span>
              </Show>
            )}
          </Index>
        </code>
      </pre>
    </div>
  )
}

const ALIGN = { left: "left", center: "center", right: "right" } as const

function Blocks(props: { blocks: MdBlock[] }): JSX.Element {
  return (
    <Index each={props.blocks}>
      {(block) => (
        <Switch>
          <Match when={block().type === "paragraph" && (block() as Extract<MdBlock, { type: "paragraph" }>)}>
            {(p) => (
              <p>
                <Inline nodes={p().children} />
              </p>
            )}
          </Match>
          <Match when={block().type === "heading" && (block() as Extract<MdBlock, { type: "heading" }>)}>
            {(h) => (
              // Replies sit under the page's own headings: # is an h3.
              <Dynamic component={`h${Math.min(6, h().level + 2)}`}>
                <Inline nodes={h().children} />
              </Dynamic>
            )}
          </Match>
          <Match when={block().type === "list" && (block() as Extract<MdBlock, { type: "list" }>)}>
            {(l) => (
              <Dynamic component={l().ordered ? "ol" : "ul"} start={l().ordered && l().start !== 1 ? l().start : undefined} class={l().loose ? "loose" : undefined}>
                <Index each={l().items}>
                  {(item) => (
                    <li class={item().checked === undefined ? undefined : "task"}>
                      <Show when={item().checked !== undefined}>
                        <input type="checkbox" disabled checked={item().checked} aria-label={item().checked ? "Done" : "Not done"} />
                      </Show>
                      <Blocks blocks={item().blocks} />
                    </li>
                  )}
                </Index>
              </Dynamic>
            )}
          </Match>
          <Match when={block().type === "code" && (block() as Extract<MdBlock, { type: "code" }>)}>{(c) => <CodeBlock lang={c().lang} text={c().text} />}</Match>
          <Match when={block().type === "quote" && (block() as Extract<MdBlock, { type: "quote" }>)}>
            {(q) => (
              <blockquote>
                <Blocks blocks={q().blocks} />
              </blockquote>
            )}
          </Match>
          <Match when={block().type === "table" && (block() as Extract<MdBlock, { type: "table" }>)}>
            {(t) => (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <Index each={t().head}>
                        {(cell, c) => (
                          <th style={t().align[c] ? { "text-align": ALIGN[t().align[c]!] } : undefined}>
                            <Inline nodes={cell()} />
                          </th>
                        )}
                      </Index>
                    </tr>
                  </thead>
                  <tbody>
                    <Index each={t().rows}>
                      {(row) => (
                        <tr>
                          <Index each={row()}>
                            {(cell, c) => (
                              <td style={t().align[c] ? { "text-align": ALIGN[t().align[c]!] } : undefined}>
                                <Inline nodes={cell()} />
                              </td>
                            )}
                          </Index>
                        </tr>
                      )}
                    </Index>
                  </tbody>
                </table>
              </div>
            )}
          </Match>
          <Match when={block().type === "rule"}>
            <hr />
          </Match>
        </Switch>
      )}
    </Index>
  )
}

export function Markdown(props: { text: string; streaming?: boolean }) {
  const blocks = createMemo(() => parseMarkdown(props.text, { streaming: props.streaming }))
  return (
    <div class="md">
      <Blocks blocks={blocks()} />
    </div>
  )
}
