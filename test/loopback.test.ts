// Loopback detection shared by the hub (CSRF, local auto-approve) and the spoke (local hub auto-start).
import { describe, expect, test } from "bun:test"
import { isLoopbackAddress, isLoopbackHost, isLoopbackURL, loopbackOrigins } from "../src/loopback"

describe("loopback", () => {
  test("hosts: localhost, 127.0.0.0/8 and ::1 in any spelling", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ["0.0.0.0", "", "voice.example.com", "localhost.evil.com", "10.0.0.1", "128.0.0.1", "::", "192.168.1.2"]) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  test("URLs: http(s) to a loopback host only", () => {
    expect(isLoopbackURL("http://127.0.0.1:4097")).toBe(true)
    expect(isLoopbackURL("http://localhost:4320/")).toBe(true)
    expect(isLoopbackURL("http://[::1]:4097")).toBe(true)
    expect(isLoopbackURL("https://voice.example.com")).toBe(false)
    expect(isLoopbackURL("http://127.0.0.1.nip.io")).toBe(false)
    expect(isLoopbackURL("ftp://127.0.0.1")).toBe(false)
    expect(isLoopbackURL("not a url")).toBe(false)
  })

  test("request addresses, including IPv4-mapped IPv6", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2"]) expect(isLoopbackAddress(ip)).toBe(true)
    for (const ip of ["10.0.0.5", "::ffff:10.0.0.5", "", undefined, "fe80::1"]) expect(isLoopbackAddress(ip)).toBe(false)
  })

  test("origins equivalent to a loopback public URL: same scheme and port on every loopback name", () => {
    expect([...loopbackOrigins("http://127.0.0.1:4320")].sort()).toEqual(["http://127.0.0.1:4320", "http://[::1]:4320", "http://localhost:4320"])
    expect([...loopbackOrigins("http://localhost")].sort()).toEqual(["http://127.0.0.1", "http://[::1]", "http://localhost"])
    expect([...loopbackOrigins("https://voice.example.com")]).toEqual(["https://voice.example.com"])
  })
})
