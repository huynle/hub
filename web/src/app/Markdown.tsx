// Renders the safe Markdown subset of lib/markdown as elements (never innerHTML).
import { For, Match, Switch, createMemo } from "solid-js"
import { Dynamic } from "solid-js/web"
import { parseInline, parseMarkdown, type Inline as InlineNode } from "../lib/markdown"

function Inline(props: { nodes: InlineNode[] }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <Switch>
          <Match when={node.type === "text" && node}>{(n) => <>{n().text}</>}</Match>
          <Match when={node.type === "code" && node}>{(n) => <code>{n().text}</code>}</Match>
          <Match when={node.type === "strong" && node}>
            {(n) => (
              <strong>
                <Inline nodes={n().children} />
              </strong>
            )}
          </Match>
          <Match when={node.type === "em" && node}>
            {(n) => (
              <em>
                <Inline nodes={n().children} />
              </em>
            )}
          </Match>
          <Match when={node.type === "link" && node}>
            {(n) => (
              <a href={n().href} target={n().href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
                <Inline nodes={n().children} />
              </a>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

const lines = (text: string) => parseInline(text)

export function Markdown(props: { text: string }) {
  const blocks = createMemo(() => parseMarkdown(props.text))
  return (
    <div class="md">
      <For each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b.type === "paragraph" && b}>
              {(p) => (
                <p>
                  <Inline nodes={lines(p().text)} />
                </p>
              )}
            </Match>
            <Match when={b.type === "heading" && b}>
              {(h) => (
                <Dynamic component={`h${Math.min(6, h().level + 2)}`}>
                  <Inline nodes={lines(h().text)} />
                </Dynamic>
              )}
            </Match>
            <Match when={b.type === "list" && b}>
              {(l) => (
                <Dynamic component={l().ordered ? "ol" : "ul"} start={l().ordered ? l().start : undefined}>
                  <For each={l().items}>
                    {(item) => (
                      <li>
                        <Inline nodes={lines(item)} />
                      </li>
                    )}
                  </For>
                </Dynamic>
              )}
            </Match>
            <Match when={b.type === "code" && b}>
              {(c) => (
                <pre class="code" data-lang={c().lang || undefined}>
                  <code>{c().text}</code>
                </pre>
              )}
            </Match>
            <Match when={b.type === "quote" && b}>
              {(q) => (
                <blockquote>
                  <Inline nodes={lines(q().text)} />
                </blockquote>
              )}
            </Match>
            <Match when={b.type === "rule"}>
              <hr />
            </Match>
          </Switch>
        )}
      </For>
    </div>
  )
}
