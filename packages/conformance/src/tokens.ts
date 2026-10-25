// Check "tokens": no token the hub gave the spoke (the machine token, session tokens, act tokens) appears in anything
// the spoke or its driver printed or sent: stdout noise, stderr, driver events and results, frames. Found as is,
// JSON-escaped, URL-encoded or base64-encoded (any alignment). Reports name the token's kind, never its value.

export interface TextSource {
  /** Where the text came from: "stderr", "stdout", "driver events", "frames" … */
  readonly source: string
  readonly text: string
}

export interface KnownToken {
  /** "machine", "session" or "act". */
  readonly kind: string
  readonly value: string
}

/** The token's base64 forms at each byte alignment, without the edge characters the neighbours change. */
function base64Forms(token: string): string[] {
  const forms: string[] = []
  for (const pad of [0, 1, 2]) {
    const padded = "\0".repeat(pad) + token
    const encoded = Buffer.from(padded, "utf8").toString("base64")
    const middle = encoded.slice(pad ? 4 : 0, encoded.length - 4)
    if (middle.length >= 8) forms.push(middle)
  }
  return forms
}

export function tokenLeaks(sources: readonly TextSource[], tokens: readonly KnownToken[]): string[] {
  const leaks: string[] = []
  for (const { source, text } of sources) {
    for (const { kind, value } of tokens) {
      if (!value) continue
      const plain = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]
      if (plain.some((form) => text.includes(form))) leaks.push(`the ${kind} token appears in ${source}`)
      else if (base64Forms(value).some((form) => text.includes(form))) leaks.push(`the ${kind} token appears in ${source} (base64)`)
    }
  }
  return leaks
}
