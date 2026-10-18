import { describe, expect, test } from "bun:test"
import { isPrivateAddress, pushEndpointProblem } from "../src/central/push-target"

const resolver = (table: Record<string, string[] | Error>) => async (host: string) => {
  const entry = table[host]
  if (entry instanceof Error) throw entry
  if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
  return entry
}

describe("isPrivateAddress", () => {
  test("loopback, private, link-local, CGNAT, unspecified, multicast and ULA addresses", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe",
    ]) expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true })
  })

  test("public addresses", () => {
    for (const ip of ["142.250.80.10", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2607:f8b0:4004:c1b::5f", "2a00:1450::1", "::ffff:8.8.8.8"]) {
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: false })
    }
  })
})

describe("pushEndpointProblem", () => {
  const publicDNS = resolver({
    "fcm.googleapis.com": ["142.250.80.10", "2607:f8b0:4004:c1b::5f"],
    "updates.push.services.mozilla.com": ["34.117.65.55"],
    "web.push.apple.com": ["17.188.128.1"],
    "wns2-by3p.notify.windows.com": ["20.42.65.92"],
    "rebind.example.com": ["93.184.215.14", "10.0.0.5"],
    "inside.example.com": ["::1"],
  })

  test("real push services are accepted", async () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QH4n",
      "https://wns2-by3p.notify.windows.com/w/?token=x",
    ]) expect(await pushEndpointProblem(endpoint, publicDNS)).toBeUndefined()
  })

  test("non-https, private IP literals and local names are rejected without a lookup", async () => {
    const lookups: string[] = []
    const spy = async (host: string) => {
      lookups.push(host)
      return ["142.250.80.10"]
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://10.0.0.1/x",
      "https://192.168.0.10:8443/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.100.100/x",
      "https://0x7f000001/x",
      "https://localhost/x",
      "https://api.localhost/x",
      "https://printer.local/x",
      "https://metadata.google.internal/x",
      "https://intranet/x",
      "https://user:pass@fcm.googleapis.com/x",
      "not a url",
    ]) expect({ endpoint, problem: await pushEndpointProblem(endpoint, spy) }).toEqual({ endpoint, problem: expect.any(String) })
    expect(lookups).toEqual([])
  })

  test("a public IP literal is accepted without a lookup", async () => {
    expect(await pushEndpointProblem("https://142.250.80.10/x", resolver({}))).toBeUndefined()
  })

  test("a hostname resolving to any private address, or failing to resolve, is rejected", async () => {
    expect(await pushEndpointProblem("https://rebind.example.com/x", publicDNS)).toMatch(/private|local/i)
    expect(await pushEndpointProblem("https://inside.example.com/x", publicDNS)).toMatch(/private|local/i)
    expect(await pushEndpointProblem("https://nxdomain.example.com/x", publicDNS)).toMatch(/resolve/i)
    expect(await pushEndpointProblem("https://empty.example.com/x", resolver({ "empty.example.com": [] }))).toMatch(/resolve/i)
  })
})
