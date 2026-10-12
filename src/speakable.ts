/** Turns an agent reply into text that sounds natural when read aloud, capped at `max` characters. */
export function speakable(text: string, max = Infinity): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, "\n(code omitted)\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+(.*?)\s*$/, (_m, heading: string) => (/[.!?:]$/.test(heading) ? heading : `${heading}.`))
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/, "\u0000$1")
        .trim(),
    )
    .filter(Boolean)

  let spoken = ""
  for (const line of lines) {
    if (line.startsWith("\u0000")) {
      const item = line.slice(1)
      spoken += spoken && !/[.!?:]$/.test(spoken) ? `. ${item}` : ` ${item}`
    } else spoken += ` ${line}`
  }
  spoken = spoken.replace(/\s+/g, " ").trim()
  return cap(spoken, max)
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}
