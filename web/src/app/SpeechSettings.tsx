// Settings → Speech: speech-to-text and text-to-speech providers, models, voices and API keys, for the user
// (inheriting the server default per field) or, for admins, the server default itself.
import { For, Show, createSignal, onMount, type JSX } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { resetPatch, speechInheritance, speechTabs, type SpeechInheritance } from "../core/account-core"
import { speechForm, speechPatch, speechSetup, validateSpeech, voicesFor, type SpeechForm, type SpeechSettings } from "../core/feedback-core"
import { pickerOptions, type PickerOption } from "../core/picker-core"
import { applyRate } from "../core/cues"
import { api, errorText, getJSON, HttpError } from "./api"
import { me, setSpeechReady, loadSpeechReady } from "./hub"
import { OptionPicker, type OptionPickerRequest } from "./OptionPicker"
import { toast } from "./toast"
import { player, voicePrefs } from "../voice/audio"

const PROVIDERS: Array<[string, string]> = [
  ["openrouter", "OpenRouter"],
  ["openai-compatible", "OpenAI-compatible"],
]
const KEY_SOURCE: Record<string, string> = { settings: "from settings", config: "from hub.json", env: "from env", user: "yours" }
const URLS = { user: "/api/settings/speech", default: "/api/settings/speech/default" } as const
const KIND_LABEL = { stt: "Speech-to-text", tts: "Text-to-speech" } as const
type Kind = "stt" | "tts"
type Scope = keyof typeof URLS

export function SpeechSettingsPanel() {
  const [scope, setScope] = createSignal<Scope>("user")
  const [tabbed, setTabbed] = createSignal(false)
  const [settings, setSettings] = createSignal<SpeechSettings | undefined>()
  const [loadError, setLoadError] = createSignal("")
  const load = async (s: Scope) => {
    setSettings(undefined)
    setLoadError("")
    try {
      const value = await getJSON<SpeechSettings>(URLS[s])
      if (s === "user") setTabbed(speechTabs(me(), value).length > 1)
      if (scope() === s) setSettings(value)
    } catch (e) {
      setLoadError(
        e instanceof HttpError && e.status === 403
          ? s === "default"
            ? "Only admins can change the server default."
            : "This account cannot change speech settings."
          : e instanceof HttpError && e.status === 404
            ? "This hub does not support speech settings."
            : `Could not load speech settings: ${errorText(e)}`,
      )
    }
  }
  onMount(() => void load("user"))
  const switchScope = (s: Scope) => {
    if (s === scope()) return
    setScope(s)
    void load(s)
  }
  return (
    <div class="speech-panel stack">
      <Show when={tabbed()}>
        <div class="chips" role="group" aria-label="Which speech settings">
          <button type="button" class="chip" aria-pressed={scope() === "user"} onClick={() => switchScope("user")}>
            Yours
          </button>
          <button type="button" class="chip" aria-pressed={scope() === "default"} onClick={() => switchScope("default")}>
            Server default
          </button>
        </div>
      </Show>
      <Show when={!loadError()} fallback={<p class="error">{loadError()}</p>}>
        <Show when={settings()} fallback={<p class="muted">Loading…</p>} keyed>
          {(s) => <SpeechEditor settings={s} scope={scope()} onSaved={(next) => setSettings(next)} />}
        </Show>
      </Show>
    </div>
  )
}

function SpeechEditor(props: { settings: SpeechSettings; scope: Scope; onSaved: (next: SpeechSettings) => void }) {
  const [form, setForm] = createStore<SpeechForm>(speechForm(props.settings))
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [status, setStatus] = createSignal<{ text: string; kind: string }>({ text: "", kind: "" })
  const [saving, setSaving] = createSignal(false)
  const [picker, setPicker] = createSignal<OptionPickerRequest | undefined>()
  const inherit = (): SpeechInheritance | undefined => (props.scope === "user" ? speechInheritance(props.settings) : undefined)
  const setup = () => (props.scope === "user" ? speechSetup(props.settings.ready, me()?.publicURL) : undefined)
  const dirty = () => Object.keys(speechPatch(props.settings, unwrap(form))).length > 0
  const modelLists: Partial<Record<Kind, Promise<PickerOption[]>>> = {}
  const models = (kind: Kind) => {
    modelLists[kind] ??= getJSON(`/api/settings/speech/models?kind=${kind}`).then(pickerOptions)
    modelLists[kind]!.catch(() => delete modelLists[kind])
    return modelLists[kind]!
  }

  const field = (kind: Kind, name: string, label: string, control: JSX.Element, help?: JSX.Element) => {
    const note = () => (inherit()?.[kind] as Record<string, { inherited: boolean; note?: string }> | undefined)?.[name]
    return (
      <div class="field">
        <label for={`sp-${kind}-${name}`}>{label}</label>
        {control}
        <Show when={note()?.inherited}>
          <p class="small inherit">{note()!.note}</p>
        </Show>
        <Show when={help}>
          <p class="small muted">{help}</p>
        </Show>
        <Show when={errors()[`${kind}.${name}`]}>
          <p class="field-error">{errors()[`${kind}.${name}`]}</p>
        </Show>
      </div>
    )
  }
  const text = (kind: Kind, name: string, attrs: JSX.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      id={`sp-${kind}-${name}`}
      type="text"
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      {...attrs}
      value={(form[kind] as unknown as Record<string, string>)[name]}
      aria-invalid={!!errors()[`${kind}.${name}`]}
      onInput={(e) => setForm(kind, name as never, e.currentTarget.value as never)}
    />
  )
  const choose = (kind: Kind, name: "model" | "voice", title: string, noun: string, load: () => Promise<PickerOption[]>) => (
    <div class="row">
      {text(kind, name, { placeholder: `Choose or type a ${noun}` })}
      <button
        type="button"
        class="btn small"
        onClick={() => setPicker({ title, noun, current: (form[kind] as unknown as Record<string, string>)[name] ?? "", load, onPick: (v) => setForm(kind, name as never, v as never) })}
      >
        Browse…
      </button>
    </div>
  )

  const keyField = (kind: Kind) => {
    const info = props.settings[kind].apiKey ?? { set: false, source: "none" }
    const inherited = () => inherit()?.[kind].apiKey
    const edit = () => form[kind].apiKey
    const clearable = () => (inherit() ? !inherited()?.inherited && info.set : info.set && info.source === "settings")
    return (
      <div class="field key-field">
        <span class="field-label">API key</span>
        <Show
          when={edit().action === "set"}
          fallback={
            <>
              <p class={`key-summary${inherited()?.inherited && edit().action !== "clear" ? " inherit" : ""}`}>
                {edit().action === "clear"
                  ? "Key will be removed when you save."
                  : inherited()?.inherited
                    ? inherited()!.note
                    : info.set
                      ? `Key set${info.last4 ? ` ••••${info.last4}` : ""} (${KEY_SOURCE[info.source] ?? info.source})`
                      : "No key set"}
              </p>
              <div class="row">
                <button type="button" class="btn small" onClick={() => setForm(kind, "apiKey", { action: "set", value: "" })}>
                  {inherited()?.inherited ? "Use your own key" : info.set ? "Replace" : "Add key"}
                </button>
                <Show when={edit().action === "clear"}>
                  <button type="button" class="btn small" onClick={() => setForm(kind, "apiKey", { action: "keep", value: "" })}>
                    Undo
                  </button>
                </Show>
                <Show when={edit().action !== "clear" && clearable()}>
                  <button type="button" class="btn small danger" onClick={() => setForm(kind, "apiKey", { action: "clear", value: "" })}>
                    Clear
                  </button>
                </Show>
              </div>
            </>
          }
        >
          <input type="password" id={`sp-${kind}-apiKey`} autocomplete="new-password" placeholder="Paste the new key" aria-label="New API key" value={edit().value} onInput={(e) => setForm(kind, "apiKey", "value", e.currentTarget.value)} />
          <div class="row">
            <button type="button" class="btn small" onClick={() => setForm(kind, "apiKey", { action: "keep", value: "" })}>
              Cancel
            </button>
          </div>
        </Show>
        <Show when={errors()[`${kind}.apiKey`]}>
          <p class="field-error">{errors()[`${kind}.apiKey`]}</p>
        </Show>
      </div>
    )
  }

  const reset = async (kind: Kind) => {
    if (!confirm(`Reset ${KIND_LABEL[kind].toLowerCase()} to the server default? Your own ${KIND_LABEL[kind].toLowerCase()} settings are removed.`)) return
    try {
      const next = await (await api(URLS.user, { method: "PUT", json: resetPatch(kind) })).json().catch(() => ({}))
      const fresh = next?.stt && next?.tts ? next : await getJSON(URLS.user)
      setSpeechReady(fresh.ready ?? null)
      props.onSaved(fresh)
      toast(`${KIND_LABEL[kind]} reset to the server default`)
    } catch (e) {
      toast(`Could not reset: ${errorText(e)}`, "err")
    }
  }

  const card = (kind: Kind) => (
    <fieldset class="card speech-card">
      <legend>{KIND_LABEL[kind]}</legend>
      <Show when={inherit()}>
        {(inh) => (
          <div class="row reset-row">
            <span class="small muted grow">{inh().own[kind] ? `${inh().own[kind]} of your own setting${inh().own[kind] === 1 ? "" : "s"}` : "All from the server default"}</span>
            <button type="button" class="btn small" disabled={!inh().own[kind]} onClick={() => void reset(kind)}>
              Reset to server default
            </button>
          </div>
        )}
      </Show>
      {field(
        kind,
        "provider",
        "Provider",
        <select id={`sp-${kind}-provider`} value={form[kind].provider} onChange={(e) => setForm(kind, "provider", e.currentTarget.value)}>
          <For each={PROVIDERS}>{([v, label]) => <option value={v}>{label}</option>}</For>
          <Show when={!PROVIDERS.some(([v]) => v === form[kind].provider)}>
            <option value={form[kind].provider}>{form[kind].provider || "—"}</option>
          </Show>
        </select>,
      )}
      <Show when={form[kind].provider === "openai-compatible"}>{field(kind, "baseURL", "Base URL", text(kind, "baseURL", { inputmode: "url", placeholder: "http://host:port/v1" }))}</Show>
      {field(kind, "model", "Model", choose(kind, "model", kind === "stt" ? "Speech-to-text model" : "Text-to-speech model", "model", () => models(kind)))}
      <Show when={kind === "tts"} fallback={field(kind, "language", "Language (optional)", text(kind, "language", { placeholder: "auto, e.g. en" }))}>
        {field(kind, "voice", "Voice", choose(kind, "voice", "Voice", "voice", async () => pickerOptions(voicesFor(props.settings.voiceHints, form.tts.model))))}
        {field(kind, "speed", "Server-side speed (optional)", text(kind, "speed", { inputmode: "decimal", placeholder: "default" }), "0.25–4, applied by the TTS provider. Your device's voice speed is separate.")}
      </Show>
      {keyField(kind)}
    </fieldset>
  )

  const save = async (e: Event) => {
    e.preventDefault()
    const current = unwrap(form)
    const errs = validateSpeech(current)
    setErrors(errs)
    if (Object.keys(errs).length) return setStatus({ text: "Fix the highlighted fields.", kind: "error" })
    const patch = speechPatch(props.settings, current)
    if (!Object.keys(patch).length) return setStatus({ text: "Nothing to save.", kind: "muted" })
    setSaving(true)
    setStatus({ text: "Saving…", kind: "muted" })
    try {
      const res = await (await api(URLS[props.scope], { method: "PUT", json: patch })).json().catch(() => ({}))
      const next = res?.stt && res?.tts ? res : await getJSON(URLS[props.scope])
      if (props.scope === "user") setSpeechReady(next.ready ?? null)
      else void loadSpeechReady()
      setForm(reconcile(speechForm(next)))
      props.onSaved(next)
      toast(props.scope === "default" ? "Server default saved" : "Speech settings saved")
    } catch (err) {
      const field = (err as HttpError).field
      if (field) setErrors({ [field]: errorText(err) })
      setStatus({ text: `Could not save: ${errorText(err)}`, kind: "error" })
    } finally {
      setSaving(false)
    }
  }

  const preview = async () => {
    setStatus({ text: dirty() ? "Previewing the saved voice (save to hear your changes)…" : "Previewing…", kind: "muted" })
    let url: string | undefined
    try {
      const blob = await (await api("/api/settings/speech/test", { method: "POST", json: { kind: "tts", text: "Hi! This is how replies will sound." } })).blob()
      url = URL.createObjectURL(blob)
      player.src = url
      applyRate(player, voicePrefs.speed)
      if (!(await player.play().then(() => true, () => false))) throw new Error("the browser blocked playback")
      setStatus({ text: "Playing preview.", kind: "muted" })
      await new Promise<void>((resolve) => (player.onended = player.onpause = player.onerror = () => resolve()))
      setStatus({ text: "", kind: "" })
    } catch (e) {
      setStatus({ text: `Preview failed: ${errorText(e)}`, kind: "error" })
    } finally {
      player.onended = player.onpause = player.onerror = null
      if (url) URL.revokeObjectURL(url)
    }
  }

  return (
    <form class="stack" novalidate onSubmit={save} onInput={() => setStatus({ text: dirty() ? "Unsaved changes." : "", kind: "muted" })}>
      <Show when={props.scope === "default"}>
        <p class="small muted">The server default is used by everyone on this hub for whatever they have not set themselves. Their own keys stay private.</p>
      </Show>
      <Show when={setup()}>
        {(s) => (
          <div class="banner">
            <div>
              <strong>Speech is not set up yet</strong>
              <p class="small">{s().reason}</p>
              <p class="small muted">OpenRouter covers both directions with one key (openrouter.ai/keys). Or point both at your own OpenAI-compatible servers.</p>
              <Show when={s().storage}>
                <p class="small muted">{s().storage}</p>
              </Show>
            </div>
          </div>
        )}
      </Show>
      {card("stt")}
      {card("tts")}
      <div class="row">
        <button type="submit" class="btn primary" disabled={saving()}>
          Save
        </button>
        <Show when={props.scope === "user"}>
          <button type="button" class="btn" onClick={() => void preview()}>
            Preview voice
          </button>
        </Show>
      </div>
      <p class={`small ${status().kind}`} role="status">
        {status().text}
      </p>
      <OptionPicker request={picker()} onClose={() => setPicker(undefined)} />
    </form>
  )
}
