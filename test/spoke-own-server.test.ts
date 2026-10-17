import { describe, expect, test } from "bun:test"
import { formOutcome, foregroundEndpoint } from "../src/spoke/own-server"

describe("foregroundEndpoint (an `opencode serve` the plugin can call back)", () => {
  test("port, hostname and the password from the environment", () => {
    expect(foregroundEndpoint(["/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4199"], { OPENCODE_PASSWORD: "pw" })).toEqual({
      url: "http://127.0.0.1:4199",
      authorization: `Basic ${btoa("opencode:pw")}`,
    })
    expect(foregroundEndpoint(["opencode", "serve", "--port=4100"], { OPENCODE_SERVER_PASSWORD: "x" })?.url).toBe("http://127.0.0.1:4100")
    expect(foregroundEndpoint(["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4100"], { OPENCODE_PASSWORD: "x" })?.url).toBe("http://127.0.0.1:4100")
  })

  test("nothing for stdio children, random ports, the service, or an unknown password", () => {
    expect(foregroundEndpoint(["opencode", "serve", "--stdio", "--port", "0"], { OPENCODE_PASSWORD: "pw" })).toBeUndefined()
    expect(foregroundEndpoint(["opencode", "serve", "--port", "0"], { OPENCODE_PASSWORD: "pw" })).toBeUndefined()
    expect(foregroundEndpoint(["opencode", "serve", "--service", "--port", "4096"], { OPENCODE_PASSWORD: "pw" })).toBeUndefined()
    expect(foregroundEndpoint(["opencode", "serve", "--port", "4100"], {})).toBeUndefined()
    expect(foregroundEndpoint(["opencode"], { OPENCODE_PASSWORD: "pw" })).toBeUndefined()
  })
})

describe("formOutcome", () => {
  test("not found and already settled mean gone; other errors are real", () => {
    expect(formOutcome({ _tag: "FormNotFoundError", id: "frm_1", message: "Form not found: frm_1" })).toBe("gone")
    expect(formOutcome({ _tag: "FormAlreadySettledError", id: "frm_1", message: "x" })).toBe("gone")
    expect(formOutcome(new Error("Form already settled: frm_1"))).toBe("gone")
    expect(formOutcome(new Error("boom"))).toBeUndefined()
  })
})
