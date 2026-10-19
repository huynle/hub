// Composer (textarea, image attachments, Send/Steer, Stop, Dictate, Voice mode split button with mic picker,
// model menus) and the inline Voice bar shown above it in Voice mode. Images come from the + button (file
// picker; phones offer the camera there), paste, or drag-and-drop onto the composer.
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import type { ComposerImage, ComposerView } from "../lib/composer"
import { IMAGE_LIMITS, IMAGE_TYPES } from "../lib/images"
import { imageFiles } from "./attach"
import type { ConversationState } from "../voice/conversation"
import { levelMeter, listMics, micDevice, setMicDevice } from "../voice/audio"
import { Icon } from "./ui"

export function Composer(props: {
  draft: string
  images: readonly ComposerImage[]
  attaching: boolean
  view: ComposerView
  error?: string
  voiceOn: boolean
  voiceBlocked: string | undefined
  dictating: false | number
  transcribing: boolean
  metaLeft: string
  voiceModel: string
  workerModel: string
  onInput: (text: string) => void
  onAttach: (files: File[]) => void
  onDetach: (id: string) => void
  onSubmit: () => void
  onStop: () => void
  onDictate: () => void
  onVoice: () => void
  onModel: (kind: "voice" | "worker") => void
}) {
  let area!: HTMLTextAreaElement
  let picker!: HTMLInputElement
  const [dragging, setDragging] = createSignal(false)
  const full = () => props.images.length >= IMAGE_LIMITS.maxImages
  const fit = () => {
    area.style.height = "auto"
    area.style.height = `${Math.min(area.scrollHeight, 280)}px`
  }
  createEffect(() => {
    props.draft
    queueMicrotask(fit)
  })
  const label = () => (props.view.primary === "steer" ? "Steer" : "Send")
  return (
    <form
      class={`composer${dragging() ? " dragging" : ""}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (props.view.canSubmit && !props.attaching) props.onSubmit()
      }}
      onDragOver={(e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer)
        setDragging(false)
        if (!files.length) return
        e.preventDefault()
        props.onAttach(files)
      }}
    >
      <Show when={props.error}>
        <p class="composer-error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={props.view.hint}>
        <p class="composer-hint muted small">{props.view.hint}</p>
      </Show>
      <div class="composer-box">
        <Show when={props.images.length || props.attaching}>
          <ul class="attachments" aria-label="Attached images">
            <For each={props.images}>
              {(image) => (
                <li class="attachment">
                  <img src={image.preview} alt={image.name} title={image.name} />
                  <button type="button" class="attachment-remove" aria-label={`Remove ${image.name}`} title="Remove" onClick={() => props.onDetach(image.id)}>
                    <Icon name="close" />
                  </button>
                </li>
              )}
            </For>
            <Show when={props.attaching}>
              <li class="attachment busy" aria-label="Preparing image">
                <span class="spinner small" />
              </li>
            </Show>
          </ul>
        </Show>
        <textarea
          ref={area}
          rows={1}
          value={props.draft}
          aria-label="Message"
          placeholder={props.voiceOn ? "Voice mode is on — talk, or type here" : props.view.primary === "steer" ? "Steer the running session…" : "Reply…"}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData)
            if (!files.length) return
            e.preventDefault()
            props.onAttach(files)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(matchMedia("(max-width: 760px)").matches && "ontouchstart" in window)) {
              e.preventDefault()
              if (props.view.canSubmit && !props.attaching) props.onSubmit()
            }
          }}
        />
        <input
          ref={picker}
          type="file"
          class="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="attach-input"
          accept={IMAGE_TYPES.join(",")}
          multiple
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            e.currentTarget.value = ""
            if (files.length) props.onAttach(files)
          }}
        />
        <div class="composer-actions">
          <button
            type="button"
            class="icon-btn"
            aria-label="Attach images"
            title={full() ? `At most ${IMAGE_LIMITS.maxImages} images per message` : "Attach images (or paste / drop them here)"}
            disabled={full() || props.attaching}
            onClick={() => picker.click()}
          >
            <Icon name="plus" />
          </button>
          <span class="grow" />
          <button
            type="button"
            class={`icon-btn${props.dictating !== false ? " recording" : ""}`}
            aria-label={props.dictating !== false ? "Stop dictation" : "Dictate"}
            title={props.voiceBlocked ?? (props.dictating !== false ? `Stop dictation (${props.dictating}s left)` : "Dictate")}
            disabled={!!props.voiceBlocked || props.transcribing || props.voiceOn}
            onClick={props.onDictate}
          >
            <Show when={!props.transcribing} fallback={<span class="spinner small" />}>
              <Icon name={props.dictating !== false ? "stop" : "mic"} />
            </Show>
          </button>
          <div class={`split${props.voiceOn ? " on" : ""}`}>
            <button
              type="button"
              class="split-main"
              aria-pressed={props.voiceOn}
              aria-label={props.voiceOn ? "End Voice mode" : "Start Voice mode"}
              title={props.voiceBlocked ?? (props.voiceOn ? "End Voice mode" : "Voice mode: talk hands-free")}
              disabled={!!props.voiceBlocked && !props.voiceOn}
              onClick={props.onVoice}
            >
              <Icon name="wave" />
            </button>
            <MicPicker />
          </div>
          <Show when={props.view.showStop}>
            <button type="button" class="btn stop" disabled={!props.view.canStop} onClick={props.onStop} aria-label="Stop the session and its subagents">
              <Icon name="stop" /> Stop
            </button>
          </Show>
          <button type="submit" class={`btn primary send ${props.view.primary}`} disabled={!props.view.canSubmit || props.attaching}>
            <Show when={props.view.primary === "send"} fallback={label()}>
              <Icon name="send" />
              <span class="sr-only">{label()}</span>
            </Show>
          </button>
        </div>
      </div>
      <div class="composer-meta">
        <span class="muted small">{props.metaLeft}</span>
        <span class="grow" />
        <button type="button" class="model-chip" onClick={() => props.onModel("voice")} title="Voice model (the orchestrator you talk to)">
          Voice: {props.voiceModel}
        </button>
        <button type="button" class="model-chip" onClick={() => props.onModel("worker")} title="Worker model (subagents that do the work)">
          Worker: {props.workerModel}
        </button>
      </div>
    </form>
  )
}

/** Chevron of the Voice split button: microphone choice with a live level meter. */
function MicPicker() {
  const [open, setOpen] = createSignal(false)
  const [mics, setMics] = createSignal<MediaDeviceInfo[]>([])
  const [level, setLevel] = createSignal(0)
  const [error, setError] = createSignal("")
  let button!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  let stopMeter: (() => void) | undefined
  const [pos, setPos] = createSignal({ right: 0, bottom: 0 })
  const meter = async () => {
    stopMeter?.()
    stopMeter = undefined
    try {
      stopMeter = await levelMeter(micDevice(), setLevel)
      setError("")
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? "Microphone permission was denied." : `Microphone: ${(e as Error).message}`)
    }
  }
  const show = async () => {
    const r = button.getBoundingClientRect()
    setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 6 })
    setOpen(true)
    if (!navigator.mediaDevices) return setError("This browser cannot use the microphone here (it needs HTTPS).")
    setMics(await listMics().catch(() => []))
    void meter()
  }
  const hide = () => {
    setOpen(false)
    stopMeter?.()
    stopMeter = undefined
    setLevel(0)
  }
  const onDoc = (e: MouseEvent) => open() && !button.contains(e.target as Node) && !panel?.contains(e.target as Node) && hide()
  const onKey = (e: KeyboardEvent) => open() && e.key === "Escape" && hide()
  document.addEventListener("mousedown", onDoc)
  document.addEventListener("keydown", onKey)
  onCleanup(() => {
    document.removeEventListener("mousedown", onDoc)
    document.removeEventListener("keydown", onKey)
    hide()
  })
  return (
    <>
      <button ref={button} type="button" class="split-chev" aria-label="Choose microphone" aria-haspopup="dialog" aria-expanded={open()} onClick={() => (open() ? hide() : void show())}>
        <Icon name="down" />
      </button>
      <Show when={open()}>
        <Portal>
          <div ref={panel} class="menu mic-picker" role="dialog" aria-label="Microphone" style={{ right: `${pos().right}px`, bottom: `${pos().bottom}px` }}>
            <div class="menu-section">Microphone</div>
            <For each={[{ deviceId: "", label: "System default" } as Pick<MediaDeviceInfo, "deviceId" | "label">, ...mics().filter((m) => m.deviceId && m.deviceId !== "default")]}>
              {(m, i) => (
                <button
                  type="button"
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={micDevice() === m.deviceId}
                  onClick={() => {
                    setMicDevice(m.deviceId)
                    void meter()
                  }}
                >
                  <span class="menu-check">{micDevice() === m.deviceId ? "✓" : ""}</span>
                  <span class="menu-label">{m.label || `Microphone ${i()}`}</span>
                </button>
              )}
            </For>
            <div class="level" aria-label="Input level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level() * 100)}>
              <span style={{ width: `${Math.round(level() * 100)}%` }} />
            </div>
            <Show when={error()}>
              <p class="error small pad">{error()}</p>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  )
}

const VOICE_LABEL: Record<ConversationState, string> = {
  starting: "Starting…",
  listening: "Listening",
  hearing: "Listening",
  transcribing: "Thinking",
  sent: "Thinking",
  speaking: "Speaking",
  paused: "Muted",
  off: "Off",
}

/** The Voice bar's tooltip: the last turn's timing, then which speech detector runs. */
function voiceTooltip(timing?: { summary: string; detail: string }, detector?: { mode: "silero" | "energy"; avgMs?: number }): string | undefined {
  const lines = timing ? [timing.summary, timing.detail] : []
  if (detector) {
    lines.push(
      detector.mode === "silero"
        ? `speech detection: on-device model${detector.avgMs ? ` (${detector.avgMs.toFixed(1)} ms per 32 ms of audio)` : ""}`
        : "speech detection: loudness (the on-device model is loading or unavailable)",
    )
  }
  return lines.length ? lines.join("\n") : undefined
}

export function VoiceBar(props: {
  state: ConversationState
  level: number
  held: string
  working: boolean
  model: string
  onMute: () => void
  onEnd: () => void
  onModel: () => void
  /** Notifications are not allowed: offer them so Voice mode shows in the notification shade. */
  notifyHint?: boolean
  onAllowNotifications?: () => void
  /** The last turn's timing, as the state's tooltip. */
  timing?: { summary: string; detail: string }
  /** The speech detector running (also in the tooltip). */
  detector?: { mode: "silero" | "energy"; avgMs?: number }
}) {
  const label = () => (props.state === "listening" && props.working ? "Thinking" : VOICE_LABEL[props.state])
  const bars = [0.5, 0.8, 1, 0.7, 0.45]
  return (
    <div class={`voice-bar ${props.state}`} role="region" aria-label="Voice mode" data-vad={props.detector?.mode}>
      <div class="wave" aria-hidden="true">
        <For each={bars}>{(k) => <span style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, (props.state === "speaking" ? 0.6 : props.level) * k * 1.6))})` }} />}</For>
      </div>
      <span class="voice-state" role="status" aria-live="polite" title={voiceTooltip(props.timing, props.detector)}>
        {label()}
        <Show when={props.held}>
          <span class="muted"> · “{props.held}…”</span>
        </Show>
      </span>
      <span class="grow" />
      <button type="button" class="model-chip" onClick={props.onModel} title="Voice model">
        {props.model}
      </button>
      <button type="button" class={`icon-btn${props.state === "paused" ? " on" : ""}`} aria-pressed={props.state === "paused"} aria-label={props.state === "paused" ? "Unmute" : "Mute"} title={props.state === "paused" ? "Unmute" : "Mute"} onClick={props.onMute}>
        <Icon name={props.state === "paused" ? "muted" : "mic"} />
      </button>
      <button type="button" class="btn small end" onClick={props.onEnd}>
        End
      </button>
      <Show when={props.notifyHint}>
        <p class="voice-hint small">
          Allow notifications to keep a “Voice mode on” notification with an End button while the screen is off.{" "}
          <button type="button" class="link" onClick={() => props.onAllowNotifications?.()}>
            Allow notifications
          </button>
        </p>
      </Show>
    </div>
  )
}
