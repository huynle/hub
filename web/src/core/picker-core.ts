// Pure logic for the option picker (speech model/voice, session models): option lists, search, ranking and
// custom values. No DOM.

export interface PickerOption {
  readonly id: string
  readonly name?: string
}

export interface PickerItem extends PickerOption {
  readonly current?: true
  readonly custom?: true
}

export interface PickerResult {
  readonly items: PickerItem[]
  readonly total: number
  readonly more: number
  readonly custom?: string
}

/** Lowercase without diacritics, for matching ("Café" → "cafe"). */
const fold = (text: unknown) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()

/**
 * Options from an API answer: an array (or `{models: [...]}`) of `{id, name?}` objects or plain strings.
 * Trimmed; entries without an id and repeated ids are dropped. `name` is kept only when it says more than the id.
 */
export function pickerOptions(raw: unknown): PickerOption[] {
  const r = raw as { models?: unknown } | null | undefined
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(r?.models) ? (r!.models as unknown[]) : []
  const seen = new Set<string>()
  const out: PickerOption[] = []
  for (const entry of list) {
    const e = entry as { id?: unknown; name?: unknown } | null
    const id = typeof entry === "string" ? entry.trim() : typeof e?.id === "string" ? e.id.trim() : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof e?.name === "string" ? e.name.trim() : ""
    out.push(name && name !== id ? { id, name } : { id })
  }
  return out
}

/** The note of a hub model list (`{models, note}`), e.g. that the provider does not label speech models. */
export function pickerNote(raw: unknown): string | undefined {
  const note = (raw as { note?: unknown } | null | undefined)?.note
  return !Array.isArray(raw) && typeof note === "string" && note.trim() ? note.trim() : undefined
}

/** Provider group of an option id: everything before its last "/" ("" when there is none). */
export const pickerGroup = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "")

/**
 * The rows to show for a search: `items` ({id, name?, current?, custom?}) ranked exact id → id prefix → other
 * matches (each in list order), with the current value first when there is no query (or listed as a custom
 * entry when it is not an option); at most `limit` items (`more` counts the rest, `total` all matches).
 * `custom` is the trimmed query when no option has exactly that id, to offer "Use “…”".
 */
export function filterPicker(
  options: readonly PickerOption[] | undefined,
  query: string,
  { current = "", limit = 200, grouped = false }: { current?: string; limit?: number; grouped?: boolean } = {},
): PickerResult {
  const q = String(query ?? "").trim()
  const fq = fold(q)
  const words = fq.split(/\s+/).filter(Boolean)
  const all: Array<PickerOption & { custom?: true }> = [...(options ?? [])]
  const cur = String(current ?? "").trim()
  if (cur && !all.some((o) => o.id === cur)) all.unshift({ id: cur, custom: true })
  const ranked: Array<{ option: PickerOption & { custom?: true }; rank: number; index: number }> = []
  all.forEach((option, index) => {
    const id = fold(option.id)
    const hay = `${id} ${fold(option.name)}`
    if (!words.every((w) => hay.includes(w))) return
    const rank = !fq ? (option.id === cur ? 0 : 1) : id === fq ? 0 : id.startsWith(fq) ? 1 : 2
    ranked.push({ option, rank, index })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  if (grouped) {
    // Stable: each provider's rows together, providers in the order of their best match.
    const order = new Map<string, number>()
    for (const r of ranked) if (!order.has(pickerGroup(r.option.id))) order.set(pickerGroup(r.option.id), order.size)
    ranked.sort((a, b) => order.get(pickerGroup(a.option.id))! - order.get(pickerGroup(b.option.id))!)
  }
  const items: PickerItem[] = ranked.slice(0, limit).map(({ option }) => ({
    id: option.id,
    ...(option.name ? { name: option.name } : {}),
    ...(cur && option.id === cur ? { current: true as const } : {}),
    ...(option.custom ? { custom: true as const } : {}),
  }))
  const exact = all.some((o) => o.id === q)
  return { items, total: ranked.length, more: Math.max(0, ranked.length - limit), ...(q && !exact ? { custom: q } : {}) }
}

/** Next active row index for arrow keys (delta ±1, wrapping) or "home" / "end"; -1 for an empty list. */
export function stepActive(active: number, delta: number | "home" | "end", count: number): number {
  if (!count) return -1
  if (delta === "home") return 0
  if (delta === "end") return count - 1
  if (active < 0) return delta > 0 ? 0 : count - 1
  return (((active + delta) % count) + count) % count
}
