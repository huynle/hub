// The act verbs on /api/agent (design §5, §8; decision wvqeuis0): thin HTTP over the acting engine (acting.ts).
//
//   POST /api/agent/sessions/:addr/approve {requestID, always?, why?}
//   POST /api/agent/sessions/:addr/deny    {requestID, why?}               why → the harness, with who denied it
//   POST /api/agent/sessions/:addr/answer  {formID, answer | cancel: true, why?}
//   POST /api/agent/sessions/:addr/prompt  {text, images? (users), delivery? "queue"|"steer", wake?, why?}
//   POST /api/agent/sessions/:addr/stop    {why?} (body optional)
//
// Users always; sessions only through their act token (allow.act; a shell token never acts); app tokens with
// scope sessions:act. Answers 200 with the engine's result, never cached. Errors: invalid 400, needs_user /
// forbidden 403 (needs_user carries `evaluation` and, once P3-T8 escalates, `decisionID`), not_found 404, gone 410,
// unsupported 422, paused 423, rate_limited 429, offline 503.
import { DELIVER_ID_MAX, DELIVERY_MODES, type DeliveryMode, type FormAnswer, formAnswerProblem, type PromptImage, promptImagesProblem } from "../../protocol"
import type { Acting } from "./acting"
import { AgentError } from "./errors"
import type { AgentRoute } from "./routes"

// A literal: routes.ts imports this module (AGENT_PREFIX is not initialised yet when it loads).
const PREFIX = "/api/agent/sessions/:addr"
const NO_STORE = { "cache-control": "no-store" }
const ACT = { act: true, scope: "sessions:act" } as const
/** Longest `why`. */
export const WHY_MAX = 1000

const invalid = (message: string) => new AgentError("invalid", message)

type Body = Record<string, unknown>

async function bodyOf(request: Request, optional = false): Promise<Body> {
  const raw = await request.text()
  if (!raw.trim() && optional) return {}
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Body must be a JSON object")
  return value as Body
}

function id(body: Body, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || !value || value.length > DELIVER_ID_MAX) throw invalid(`${key} must be 1–${DELIVER_ID_MAX} characters`)
  return value
}

function why(body: Body): { why?: string } {
  const value = body.why
  if (value === undefined) return {}
  if (typeof value !== "string" || value.length > WHY_MAX) throw invalid(`why must be a string of at most ${WHY_MAX} characters`)
  return value.trim() ? { why: value.trim() } : {}
}

function flag(body: Body, key: string): boolean | undefined {
  const value = body[key]
  if (value !== undefined && typeof value !== "boolean") throw invalid(`${key} must be true or false`)
  return value
}

const ok = (result: unknown) => Response.json(result, { headers: NO_STORE })

export function actingRoutes(acting: Acting): AgentRoute[] {
  return [
    {
      method: "POST",
      path: `${PREFIX}/approve`,
      allow: ACT,
      async handle({ request, params, actor, user }) {
        const body = await bodyOf(request)
        const always = flag(body, "always")
        return ok(await acting.approve({ actor, userID: user.id }, params.addr!, { requestID: id(body, "requestID"), ...(always ? { always } : {}), ...why(body) }))
      },
    },
    {
      method: "POST",
      path: `${PREFIX}/deny`,
      allow: ACT,
      async handle({ request, params, actor, user }) {
        const body = await bodyOf(request)
        return ok(await acting.deny({ actor, userID: user.id }, params.addr!, { requestID: id(body, "requestID"), ...why(body) }))
      },
    },
    {
      method: "POST",
      path: `${PREFIX}/answer`,
      allow: ACT,
      async handle({ request, params, actor, user }) {
        const body = await bodyOf(request)
        const formID = id(body, "formID")
        const cancel = flag(body, "cancel") === true
        if (cancel ? body.answer !== undefined : body.cancel !== undefined) throw invalid("Send either an answer or cancel: true")
        const caller = { actor, userID: user.id }
        if (cancel) return ok(await acting.answer(caller, params.addr!, { formID, cancel: true, ...why(body) }))
        const problem = formAnswerProblem(body.answer)
        if (problem) throw invalid(problem)
        return ok(await acting.answer(caller, params.addr!, { formID, answer: body.answer as FormAnswer, ...why(body) }))
      },
    },
    {
      method: "POST",
      path: `${PREFIX}/prompt`,
      allow: ACT,
      async handle({ request, params, actor, user }) {
        const body = await bodyOf(request)
        if (typeof body.text !== "string") throw invalid("text must be a string")
        const delivery = body.delivery
        if (delivery !== undefined && !(DELIVERY_MODES as readonly unknown[]).includes(delivery)) throw invalid(`delivery must be one of ${DELIVERY_MODES.join(", ")}`)
        const wake = flag(body, "wake")
        let images: PromptImage[] | undefined
        if (body.images !== undefined) {
          const problem = promptImagesProblem(body.images)
          if (problem) throw invalid(problem)
          // Only the validated fields go on.
          images = (body.images as PromptImage[]).map(({ mime, data, name }) => ({ mime, data, ...(name ? { name } : {}) }))
        }
        return ok(
          await acting.prompt({ actor, userID: user.id }, params.addr!, {
            text: body.text,
            ...(images ? { images } : {}),
            ...(delivery ? { delivery: delivery as DeliveryMode } : {}),
            ...(wake !== undefined ? { wake } : {}),
            ...why(body),
          }),
        )
      },
    },
    {
      method: "POST",
      path: `${PREFIX}/stop`,
      allow: ACT,
      async handle({ request, params, actor, user }) {
        const body = await bodyOf(request, true)
        return ok(await acting.stop({ actor, userID: user.id }, params.addr!, why(body)))
      },
    },
  ]
}
