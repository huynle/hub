// A searchable option list in a dialog (speech models and voices): loads options, ranks matches, offers the
// typed text as a custom value. Arrow keys move, Enter picks.
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { filterPicker, stepActive, type PickerOption } from "../core/picker-core"
import { errorText } from "./api"
import { Dialog } from "./ui"

export interface OptionPickerRequest {
  title: string
  noun: string
  current: string
  load: () => Promise<PickerOption[]>
  onPick: (value: string) => void
}

export function OptionPicker(props: { request: OptionPickerRequest | undefined; onClose: () => void }) {
  const [query, setQuery] = createSignal("")
  const [options, setOptions] = createSignal<PickerOption[] | undefined>()
  const [error, setError] = createSignal("")
  const [active, setActive] = createSignal(0)
  const load = () => {
    const req = props.request
    if (!req) return
    setOptions(undefined)
    setError("")
    req.load().then(setOptions, (e) => setError(errorText(e)))
  }
  createEffect(
    on(
      () => props.request,
      (req) => {
        if (!req) return
        setQuery("")
        setActive(0)
        load()
      },
    ),
  )
  const result = createMemo(() => filterPicker(options() ?? [], query(), { current: props.request?.current }))
  const values = () => [...result().items.map((i) => i.id), ...(result().custom ? [result().custom!] : [])]
  const pick = (value: string) => {
    const req = props.request
    props.onClose()
    req?.onPick(value)
  }
  const noun = () => props.request?.noun ?? "option"
  return (
    <Dialog open={!!props.request} title={props.request?.title ?? ""} onClose={props.onClose} class="picker">
      <input
        type="search"
        class="picker-search"
        placeholder={`Search or type a ${noun()}`}
        aria-label={`Search ${noun()}s`}
        value={query()}
        autofocus
        onInput={(e) => {
          setQuery(e.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          const moves: Record<string, number | "home" | "end"> = { ArrowDown: 1, ArrowUp: -1 }
          if (e.key in moves) {
            e.preventDefault()
            setActive(stepActive(active(), moves[e.key]!, values().length))
          } else if (e.key === "Enter") {
            e.preventDefault()
            const v = values()[active()]
            if (v) pick(v)
          }
        }}
      />
      <p class="muted small" role="status">
        {error()
          ? `Couldn't load the ${noun()} list: ${error()}. Type any ${noun()}.`
          : options() === undefined
            ? `Loading ${noun()}s…`
            : !options()!.length
              ? `No suggestions. Type any ${noun()}.`
              : `${result().total} ${result().total === 1 ? noun() : `${noun()}s`}`}
        <Show when={error()}>
          {" "}
          <button type="button" class="btn small" onClick={load}>
            Retry
          </button>
        </Show>
      </p>
      <ul class="picker-list" role="listbox">
        <For each={result().items}>
          {(item, i) => (
            <li>
              <button type="button" class={`picker-opt${active() === i() ? " active" : ""}`} aria-selected={!!item.current} onClick={() => pick(item.id)}>
                <span class="po-name">{item.id}</span>
                <Show when={item.name}>
                  <span class="po-id muted">{item.name}</span>
                </Show>
                <Show when={item.current}>
                  <span class="po-mark">✓ Current</span>
                </Show>
              </button>
            </li>
          )}
        </For>
        <Show when={result().custom}>
          <li>
            <button type="button" class={`picker-opt${active() === result().items.length ? " active" : ""}`} onClick={() => pick(result().custom!)}>
              <span class="po-name">Use “{result().custom}”</span>
              <span class="po-id muted">as a custom {noun()}</span>
            </button>
          </li>
        </Show>
      </ul>
    </Dialog>
  )
}
