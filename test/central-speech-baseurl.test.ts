import { describe, expect, test } from "bun:test"
import { validBaseURL } from "../src/central/speech/settings"

describe("validBaseURL allows plain http only on private networks", () => {
  test.each([
    "http://localhost:8880/v1",
    "http://127.0.0.1:8880",
    "http://kokoro:8880/v1",
    "http://speech.local/v1",
    "http://tts.lan:9000",
    "http://stt.internal",
    "http://10.0.0.20:8000/v1",
    "http://192.168.1.5",
    "http://172.20.0.4:8880",
    "http://100.70.226.55:8880",
    "https://api.example.com/v1",
  ])("accepts %s", (url) => {
    expect(() => validBaseURL(url, "baseURL")).not.toThrow()
  })

  test.each(["http://api.example.com/v1", "http://8.8.8.8", "http://172.32.0.1", "ftp://x.local"])("rejects %s", (url) => {
    expect(() => validBaseURL(url, "baseURL")).toThrow()
  })
})
