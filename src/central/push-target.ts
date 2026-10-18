// Push endpoints come from browsers, and the hub POSTs to them: without checks a subscription could make the
// hub send requests into its own network (SSRF). An endpoint must be https on a public hostname; hosts are
// resolved at subscribe time and rejected when any address is loopback, private, link-local, CGNAT, ULA,
// unspecified or multicast. Real push services (FCM, Mozilla, Apple, WNS) are public names on public addresses.
import { lookup } from "node:dns/promises"
import { isIPv4, isIPv6 } from "node:net"

export type ResolveHost = (host: string) => Promise<readonly string[]>

/** Every address the system resolver returns for a host. */
export const resolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** IPv4 [network, prefix length] blocks that never reach a public push service. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
]

const v4Number = (ip: string): number => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0)

function privateV4(ip: string): boolean {
  const n = v4Number(ip)
  return V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(net) / 2 ** (32 - bits)))
}

/** The eight 16-bit groups of an IPv6 address (with any embedded IPv4 tail converted). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().replace(/%.*$/, "")
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const n = v4Number(tail[1]!)
    text = `${text.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, rest] = text.split("::") as [string, string | undefined]
  const left = head ? head.split(":") : []
  const right = rest === undefined ? [] : rest ? rest.split(":") : []
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill("0")
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16))
}

/** True for addresses a push endpoint must not resolve to. Anything that is not an IP counts as private. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[(.*)\]$/, "$1")
  if (isIPv4(ip)) return privateV4(ip)
  if (!isIPv6(ip)) return true
  const g = v6Groups(ip)
  const first = g[0]!
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, which includes :: and ::1).
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true
    return privateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`)
  }
  if (first === 0x64 && g[1] === 0xff9b) return privateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`) // NAT64
  return (
    (first & 0xfe00) === 0xfc00 || // ULA fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (first & 0xff00) === 0xff00 // multicast
  )
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"]

/** Why an endpoint is not acceptable for Web Push, or undefined when it is. */
export async function pushEndpointProblem(endpoint: string, resolve: ResolveHost): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return "Push endpoint is not a URL"
  }
  if (url.protocol !== "https:") return "Push endpoint must be https"
  if (url.username || url.password) return "Push endpoint must not carry credentials"
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")
  if (isIPv4(host) || isIPv6(host)) return isPrivateAddress(host) ? "Push endpoint is a private or local address" : undefined
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "Push endpoint is a local hostname"
  }
  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch {
    return `Push endpoint host ${host} does not resolve`
  }
  if (addresses.length === 0) return `Push endpoint host ${host} does not resolve`
  if (addresses.some(isPrivateAddress)) return "Push endpoint resolves to a private or local address"
  return undefined
}
