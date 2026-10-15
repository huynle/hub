// Same-origin JSON API calls with the device cookie. Errors carry the HTTP status and the hub's `code`/`field`.

export class HttpError extends Error {
  code?: string
  field?: string
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
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
  const res = await fetch(path, init)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; field?: string }
    if (res.status === 401) onUnauthorized?.()
    const error = new HttpError(res.status, data.error || `HTTP ${res.status}`)
    if (typeof data.field === "string") error.field = data.field
    if (typeof data.code === "string") error.code = data.code
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
