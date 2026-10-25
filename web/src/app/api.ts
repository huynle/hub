// Same-origin JSON API calls with the device cookie. Errors carry the HTTP status and the hub's `code`/`field`
// (console routes: {error: string, code?, field?}) or `code`/`hint` (/api/agent routes: {error: {code, message, hint?}}).

export class HttpError extends Error {
  code?: string
  field?: string
  hint?: string
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The request never got an HTTP answer: the connection failed or was cut (offline, a proxy closing it, the hub
 * restarting). Browsers report this as a bare TypeError ("Failed to fetch", "Load failed", "NetworkError when
 * attempting to fetch resource"); this carries a message people can act on instead.
 */
export class NetworkError extends Error {
  override readonly name = "NetworkError"
  constructor(readonly cause?: unknown) {
    super("Can't reach the hub: the connection dropped. Check your network and try again.")
  }
}

export interface ApiInit {
  method?: string
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  keepalive?: boolean
}

let onUnauthorized: (() => void) | undefined
/** Called on any 401 (the device was revoked or signed out). */
export function setUnauthorized(fn: () => void): void {
  onUnauthorized = fn
}

export async function api(path: string, { method = "GET", json, body, headers = {}, signal, keepalive }: ApiInit = {}): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { ...headers }, signal, keepalive }
  if (json !== undefined) {
    ;(init.headers as Record<string, string>)["content-type"] = "application/json"
    init.body = JSON.stringify(json)
  } else if (body !== undefined) init.body = body
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (cause) {
    // fetch rejects with a TypeError only for network-level failures; aborts (AbortError) pass through.
    if (cause instanceof TypeError) throw new NetworkError(cause)
    throw cause
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 401) onUnauthorized?.()
    // The agent envelope nests code, message and hint in `error`.
    const body = data.error && typeof data.error === "object" ? (data.error as Record<string, unknown>) : data
    const message = typeof data.error === "string" ? data.error : typeof body.message === "string" ? body.message : ""
    const error = new HttpError(res.status, message || `HTTP ${res.status}`)
    if (typeof body.field === "string") error.field = body.field
    if (typeof body.code === "string") error.code = body.code
    if (typeof body.hint === "string") error.hint = body.hint
    throw error
  }
  return res
}

export const getJSON = async <T = any>(path: string): Promise<T> => (await api(path)).json() as Promise<T>
export const postJSON = async <T = any>(path: string, json: unknown = {}): Promise<T> =>
  (await api(path, { method: "POST", json })).json().catch(() => ({})) as Promise<T>

export const enc = encodeURIComponent
export const sessionPath = (id: string) => `/api/sessions/${enc(id)}`

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
