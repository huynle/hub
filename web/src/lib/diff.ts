// Unified diff text (GET /api/sessions/:id/diff) as numbered lines for the diff viewer.

export interface PatchLine {
  readonly type: "meta" | "hunk" | "context" | "add" | "del"
  readonly text: string
  readonly oldNo?: number
  readonly newNo?: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of String(patch ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      out.push({ type: "hunk", text: line })
      continue
    }
    if (!inHunk || line.startsWith("\\")) {
      if (line) out.push({ type: "meta", text: line })
      continue
    }
    if (line.startsWith("+")) out.push({ type: "add", text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith("-")) out.push({ type: "del", text: line.slice(1), oldNo: oldNo++ })
    else if (line.startsWith(" ") || line === "") {
      if (line === "" && out.length && out[out.length - 1]!.type !== "context") continue
      out.push({ type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else {
      inHunk = false
      out.push({ type: "meta", text: line })
    }
  }
  return out
}
