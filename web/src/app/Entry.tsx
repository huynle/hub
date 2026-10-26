// Screens outside the console shell: /pair (pairing code or Google sign-in) and /approve?code= (machine approval).
import { Show, createSignal, onMount } from "solid-js"
import { approveOwner, isAdmin, signInURL } from "../core/account-core"
import { api, enc, errorText, HttpError } from "./api"
import { enrollments, loadAuth, loadEnrollments, me, setMe } from "./hub"
import { HubMark } from "./HubMark"
import { navigate } from "./router"
import { ago } from "./ui"

function defaultDeviceName(): string {
  const ua = navigator.userAgent
  const model = /Pixel[^;)]*/.exec(ua)?.[0] || (/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser")
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ""
  return `${model.trim()}${browser ? ` · ${browser}` : ""}`.slice(0, 64)
}

export function Pair(props: { next: string; error: string }) {
  const [google, setGoogle] = createSignal<string | undefined>()
  const [ready, setReady] = createSignal(false)
  const [code, setCode] = createSignal("")
  const [name, setName] = createSignal(defaultDeviceName())
  const [error, setError] = createSignal(props.error ? `Sign-in did not work: ${props.error}` : "")
  const [busy, setBusy] = createSignal(false)
  onMount(async () => {
    const [res, auth] = await Promise.all([fetch("/api/me", { credentials: "same-origin" }).catch(() => undefined), loadAuth()])
    if (res?.ok) {
      setMe(await res.json())
      return navigate(props.next, { replace: true })
    }
    setGoogle(signInURL(auth ?? undefined, props.next))
    setReady(true)
  })
  const submit = async (e: Event) => {
    e.preventDefault()
    const value = code().replace(/\D/g, "")
    if (value.length !== 6) return setError("Enter the 6-digit code.")
    setBusy(true)
    setError("")
    try {
      await api("/api/pair", { method: "POST", json: { code: value, deviceName: name().trim() || defaultDeviceName() } })
      setMe(undefined)
      navigate(props.next, { replace: true })
    } catch (err) {
      setError(err instanceof HttpError && err.status === 401 ? "That code is wrong or expired. Get a fresh one and try again." : errorText(err))
      setBusy(false)
    }
  }
  const form = () => (
    <form class="card stack" onSubmit={submit} novalidate>
      <div class="field">
        <label for="pair-code">Pairing code</label>
        <input id="pair-code" class="pair-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
      </div>
      <p class="small muted">In OpenCode run /hub → Pair a phone on a computer connected to this hub to get a 6-digit code. For the very first device, use the code printed in the hub's log.</p>
      <div class="field">
        <label for="pair-name">Device name</label>
        <input id="pair-name" type="text" maxlength="64" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </div>
      <Show when={error()}>
        <p class="error" role="alert">
          {error()}
        </p>
      </Show>
      <button type="submit" class="btn primary" disabled={busy()}>
        Pair
      </button>
    </form>
  )
  return (
    <main class="entry">
      <h1 class="display brand-big">
        <HubMark class="brand-mark" size={30} /> Hub
      </h1>
      <Show when={ready()} fallback={<p class="muted">Loading…</p>}>
        <Show
          when={google()}
          fallback={
            <>
              <p class="muted">Pair this browser with your hub to see and control your OpenCode sessions.</p>
              {form()}
            </>
          }
        >
          <p class="muted">Sign in to see and control your own OpenCode sessions.</p>
          <a class="btn primary signin" href={google()}>
            Sign in with Google
          </a>
          <details class="card" open={!!props.error}>
            <summary>Have a pairing code?</summary>
            {form()}
          </details>
        </Show>
      </Show>
    </main>
  )
}

export function Approve(props: { code: string }) {
  const code = () => props.code.toUpperCase()
  const [result, setResult] = createSignal("")
  const [done, setDone] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loaded, setLoaded] = createSignal(!isAdmin(me()))
  onMount(async () => {
    await loadEnrollments()
    setLoaded(true)
  })
  const pending = () => enrollments().find((e) => e.userCode === code())
  const gone = () => `No pending request with code ${code()}. It may have expired or been answered already.`
  const decide = async (action: "approve" | "deny") => {
    setBusy(true)
    const name = pending()?.machineName
    try {
      await api(`/api/enrollments/${enc(code())}/${action}`, { method: "POST", json: {} })
      setDone(action === "approve" ? `${name ?? "The machine"} is approved and belongs to you. It will connect in a few seconds.` : `Denied ${name ?? `the request with code ${code()}`}.`)
    } catch (e) {
      setResult(e instanceof HttpError && e.status === 404 ? gone() : errorText(e))
      setBusy(false)
    }
  }
  return (
    <main class="entry">
      <h1 class="display">Approve machine</h1>
      <div class="card stack">
        <Show when={!done()} fallback={<p role="status">{done()}</p>}>
          <Show when={code()} fallback={<p>No code given.</p>}>
            <Show when={loaded()} fallback={<p class="muted">Loading…</p>}>
              <Show when={!isAdmin(me()) || pending()} fallback={<p>{gone()}</p>}>
                <p>
                  <Show when={pending()} fallback={<>A machine showing code <strong class="mono">{code()}</strong> wants to connect to this hub.</>}>
                    <strong>{pending()!.machineName}</strong> wants to connect to this hub.
                  </Show>
                </p>
                <p class="small muted">
                  {pending() ? `Code ${pending()!.userCode} · requested ${ago(pending()!.created)}. ` : ""}Approve only if this code matches the one shown in OpenCode.
                </p>
                <p class="small">{approveOwner(me())}</p>
                <div class="row">
                  <button type="button" class="btn primary" disabled={busy()} onClick={() => void decide("approve")}>
                    Approve
                  </button>
                  <button type="button" class="btn danger" disabled={busy()} onClick={() => void decide("deny")}>
                    Deny
                  </button>
                </div>
                <Show when={result()}>
                  <p role="status">{result()}</p>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
        <a class="btn" href="/">
          Back to sessions
        </a>
      </div>
    </main>
  )
}
