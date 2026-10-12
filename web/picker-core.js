// Pure logic for the option picker sheet (Settings → Speech model and voice): option lists, search,
// ranking and custom values. No DOM. Imported by web/app.js and by bun tests.

/** Lowercase without diacritics, for matching ("Café" → "cafe"). */
const fold = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()

/**
 * Options from an API answer: an array (or `{models: [...]}`) of `{id, name?}` objects or plain strings.
 * Trimmed; entries without an id and repeated ids are dropped. `name` is kept only when it says more than the id.
 */
export function pickerOptions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const id = typeof entry === "string" ? entry.trim() : typeof entry?.id === "string" ? entry.id.trim() : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof entry?.name === "string" ? entry.name.trim() : ""
    out.push(name && name !== id ? { id, name } : { id })
  }
  return out
}

/**
 * The rows to show for a search: `items` ({id, name?, current?, custom?}) ranked exact id → id prefix → other
 * matches (each in list order), with the current value first when there is no query (or listed as a custom
 * entry when it is not an option); at most `limit` items (`more` counts the rest, `total` all matches).
 * `custom` is the trimmed query when no option has exactly that id, to offer "Use “…”".
 */
export function filterPicker(options, query, { current = "", limit = 200 } = {}) {
  const q = String(query ?? "").trim()
  const fq = fold(q)
  const words = fq.split(/\s+/).filter(Boolean)
  const all = [...(options ?? [])]
  const cur = String(current ?? "").trim()
  if (cur && !all.some((o) => o.id === cur)) all.unshift({ id: cur, custom: true })
  const ranked = []
  all.forEach((option, index) => {
    const id = fold(option.id)
    const hay = `${id} ${fold(option.name)}`
    if (!words.every((w) => hay.includes(w))) return
    const rank = !fq ? (option.id === cur ? 0 : 1) : id === fq ? 0 : id.startsWith(fq) ? 1 : 2
    ranked.push({ option, rank, index })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  const items = ranked.slice(0, limit).map(({ option }) => ({
    id: option.id,
    ...(option.name ? { name: option.name } : {}),
    ...(cur && option.id === cur ? { current: true } : {}),
    ...(option.custom ? { custom: true } : {}),
  }))
  const exact = all.some((o) => o.id === q)
  return { items, total: ranked.length, more: Math.max(0, ranked.length - limit), ...(q && !exact ? { custom: q } : {}) }
}

/** Next active row index for arrow keys (delta ±1, wrapping) or "home" / "end"; -1 for an empty list. */
export function stepActive(active, delta, count) {
  if (!count) return -1
  if (delta === "home") return 0
  if (delta === "end") return count - 1
  if (active < 0) return delta > 0 ? 0 : count - 1
  return (((active + delta) % count) + count) % count
}
