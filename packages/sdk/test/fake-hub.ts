// A fake hub for the SDK tests (Bun.serve): routes by "METHOD /path"; every request is recorded.
interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
}

type Handler = (request: Request, url: URL) => Response | Promise<Response>

const headersOf = (request: Request) => {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => (headers[key] = value))
  return headers
}

/** A fake hub: `routes["GET /api/agent/whoami"] = () => Response.json(...)`; every request is recorded. */
export function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      seen.push({ method: request.method, path: url.pathname + url.search, headers: headersOf(request), ...(text ? { body: JSON.parse(text) } : {}) })
      const handler = routes[`${request.method} ${url.pathname}`]
      if (!handler) return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })
      return handler(request, url)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, routes, seen, stop: () => server.stop(true) }
}
