// Inline session rename: the title (children) turns into a text field while renaming here. The field opens with
// the title selected; Enter (or leaving the field) saves, Escape cancels. Saving is optimistic (renameSession).
// The ✨ button next to the field asks OpenCode to name the session instead (Auto-name).
import { Show, onCleanup, onMount, type JSX } from "solid-js"
import { MAX_TITLE } from "../core/view-core"
import { isRenaming, renaming, setRenaming, type RenamePlace } from "./actions"
import { autoNameSession, autoNaming, renameSession } from "./hub"

/**
 * What was typed so far. A catalog update re-creates the row (and the field) while typing; the new field picks the
 * text up instead of starting over.
 */
let draft: { id: string; place: RenamePlace; value: string } | undefined
/** Rename fields on screen; when the last one goes away for good (e.g. navigating away), renaming ends. */
let mounted = 0

export function RenameTitle(props: { id: string; title: string; place: RenamePlace; class?: string; children: JSX.Element }) {
  return (
    <Show when={isRenaming(props.id, props.place)} fallback={props.children}>
      <RenameField id={props.id} title={props.title} place={props.place} class={props.class} />
    </Show>
  )
}

/** "Naming…" next to a session title while OpenCode is generating it (Auto-name). */
export function Naming(props: { id: string }) {
  return (
    <Show when={autoNaming(props.id)}>
      <span class="naming muted small" role="status">
        <span class="spinner small" aria-hidden="true" />
        Naming…
      </span>
    </Show>
  )
}

function RenameField(props: { id: string; title: string; place: RenamePlace; class?: string }) {
  let input!: HTMLInputElement
  let done = false
  const resumed = draft && draft.id === props.id && draft.place === props.place ? draft.value : undefined
  const auto = () => {
    if (done) return
    done = true
    draft = undefined
    setRenaming(undefined)
    void autoNameSession(props.id)
  }
  const finish = (save: boolean) => {
    if (done) return
    done = true
    const value = input.value
    draft = undefined
    setRenaming(undefined)
    if (save && value.trim() && value.trim() !== props.title) void renameSession(props.id, value)
  }
  onMount(() => {
    mounted++
    input.focus()
    if (resumed === undefined) input.select()
  })
  // Removed without Enter/Escape (the row was re-created, or another rename started): keep the draft, and
  // ignore the blur that removing a focused field fires.
  onCleanup(() => {
    mounted--
    // Not re-created right away (the row left the list, or the page changed): stop renaming, drop the draft.
    setTimeout(() => {
      if (mounted > 0) return
      draft = undefined
      if (renaming()?.id === props.id && renaming()?.place === props.place) setRenaming(undefined)
    }, 0)
    if (done) return
    done = true
    const current = renaming()
    if (current?.id === props.id && current.place === props.place) draft = { id: props.id, place: props.place, value: input.value }
  })
  return (
    <span class="rename-wrap">
    <input
      ref={input}
      type="text"
      class={`rename-field${props.class ? ` ${props.class}` : ""}`}
      aria-label="Session title"
      value={resumed ?? props.title}
      maxLength={MAX_TITLE}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") {
          e.preventDefault()
          finish(true)
        } else if (e.key === "Escape") {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
    <button
      type="button"
      class="icon-btn small auto-name-btn"
      aria-label="Auto-name"
      title="Let OpenCode name this session"
      // Keep the field focused (its blur would save what is typed) until the click lands here.
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        auto()
      }}
    >
      ✨
    </button>
    </span>
  )
}
