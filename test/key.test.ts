import { describe, expect, test } from "bun:test"
import { resolveOpenRouterKey, type KeySources } from "../src/key"

const sources = (overrides: Partial<KeySources> = {}): KeySources => ({
  active: async () => undefined,
  resolve: async () => undefined,
  env: {},
  ...overrides,
})

describe("resolveOpenRouterKey", () => {
  test("prefers the key stored in OpenCode's openrouter integration", async () => {
    const requested: string[] = []
    const key = await resolveOpenRouterKey(
      sources({
        active: async (id) => {
          requested.push(id)
          return { id: "conn" }
        },
        resolve: async () => ({ type: "key", key: "sk-integration" }),
        env: { OPENROUTER_API_KEY: "sk-env" },
      }),
      "sk-option",
    )
    expect(key).toBe("sk-integration")
    expect(requested).toEqual(["openrouter"])
  })

  test("falls back to OPENROUTER_API_KEY, then the plugin option", async () => {
    expect(await resolveOpenRouterKey(sources({ env: { OPENROUTER_API_KEY: "sk-env" } }), "sk-option")).toBe("sk-env")
    expect(await resolveOpenRouterKey(sources(), "sk-option")).toBe("sk-option")
    expect(await resolveOpenRouterKey(sources(), undefined)).toBeUndefined()
  })

  test("ignores non-key credentials and integration errors", async () => {
    const oauth = sources({ active: async () => ({}), resolve: async () => ({ type: "oauth" }), env: { OPENROUTER_API_KEY: "sk-env" } })
    expect(await resolveOpenRouterKey(oauth, undefined)).toBe("sk-env")
    const broken = sources({
      active: async () => {
        throw new Error("no integration")
      },
      env: { OPENROUTER_API_KEY: "sk-env" },
    })
    expect(await resolveOpenRouterKey(broken, undefined)).toBe("sk-env")
  })
})
