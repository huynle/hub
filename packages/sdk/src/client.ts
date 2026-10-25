// The hub client: bearer requests to the hub's /api/agent with JSON bodies and query strings; failures become
// HubError (the envelope) or HubTransportError (errors.ts). Typed verbs are added on top of call()/request().
import { envelopeOf, HubError, HubTransportError } from "./errors.ts"

export type QueryValue = string | number | boolean | readonly string[] | undefined

export interface RequestOptions {
  /** Query parameters; undefined values are skipped, arrays repeat the key. */
  readonly query?: Readonly<Record<string, QueryValue>>
  /** Sent as JSON. */
  readonly body?: unknown
  readonly signal?: AbortSignal
}

/** The part of fetch the client uses. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export interface HubClientOptions {
  /** The hub's base URL, e.g. https://hub.example.com. */
  readonly url: string
  /** A session token (HUB_SESSION_TOKEN), an app token or a device token. */
  readonly token: string
  /** Defaults to the global fetch. */
  readonly fetch?: Fetch
}

/** `?a=1&b=2` (repeated keys for arrays); empty when nothing is set. */
export function queryString(query: Readonly<Record<string, QueryValue>> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v))
  }
  const text = params.toString()
  return text ? `?${text}` : ""
}

export class HubClient {
  /** The URL as given (used in messages). */
  readonly url: string
  readonly #base: string
  readonly #token: string
  readonly #fetch: Fetch

  constructor(options: HubClientOptions) {
    this.url = options.url
    this.#base = options.url.replace(/\/+$/, "")
    this.#token = options.token
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Sends a request; resolves the response when OK, else throws HubError / HubTransportError. */
  async request(method: string, pathname: string, options: RequestOptions = {}): Promise<Response> {
    const target = `${pathname}${queryString(options.query)}`
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: "application/json" }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    let response: Response
    try {
      response = await this.#fetch(`${this.#base}${target}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        redirect: "manual",
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new HubTransportError("unreachable", `cannot reach ${this.url} (${cause instanceof Error ? cause.message : String(cause)})`, { cause })
    }
    if (response.ok) return response
    const text = await response.text().catch(() => "")
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const envelope = envelopeOf(body)
    if (envelope) throw new HubError(response.status, envelope)
    throw new HubTransportError("http", `HTTP ${response.status} from ${this.url}${target}`, { status: response.status })
  }

  /** request() answering JSON (undefined for 204). */
  async call<T = unknown>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, pathname, options)
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch (cause) {
      throw new HubTransportError("bad_response", `the hub at ${this.url} did not answer JSON for ${pathname}${queryString(options.query)}`, { cause })
    }
  }
}
