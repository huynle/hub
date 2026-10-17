// Answering an OpenCode form (the question tool, or any form) in the console: the hub sends each form
// blocker's fields (src/status.ts FormFieldSpec); this turns what the user entered into OpenCode's answer.

export interface FormOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface FormField {
  readonly key: string
  readonly type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly options?: readonly FormOption[]
  readonly custom?: boolean
  readonly placeholder?: string
  readonly default?: string | number | boolean | readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly pattern?: string
  readonly url?: string
  readonly when?: ReadonlyArray<{ readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }>
}

/** What the inputs hold: text (also numbers while typed), a checkbox, or the chosen options. */
export type FormValue = string | boolean | string[]
export type FormValues = Record<string, FormValue>
export type FormAnswer = Record<string, string | number | boolean | string[]>

export function initialFormValues(fields: readonly FormField[]): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    if (f.type === "external") continue
    if (f.type === "boolean") out[f.key] = f.default === true
    else if (f.type === "multiselect") out[f.key] = Array.isArray(f.default) ? [...f.default] : []
    else out[f.key] = f.default === undefined || Array.isArray(f.default) ? "" : String(f.default)
  }
  return out
}

/** The value as OpenCode would compare it in a `when` condition. */
function comparable(field: FormField | undefined, value: FormValue | undefined): unknown {
  if (field && (field.type === "number" || field.type === "integer") && typeof value === "string" && value.trim()) return Number(value)
  return typeof value === "string" ? value.trim() : value
}

/** Fields whose `when` conditions hold for the current values. */
export function visibleFields(fields: readonly FormField[], values: FormValues): FormField[] {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  return fields.filter((f) =>
    (f.when ?? []).every((w) => {
      const equal = comparable(byKey.get(w.key), values[w.key]) === w.value
      return w.op === "eq" ? equal : !equal
    }),
  )
}

const text = (v: FormValue | undefined) => (typeof v === "string" ? v.trim() : "")

/** Field key → problem, for the visible fields; empty when the form can be sent. */
export function validateForm(fields: readonly FormField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of visibleFields(fields, values)) {
    const problem = fieldProblem(f, values[f.key])
    if (problem) errors[f.key] = problem
  }
  return errors
}

function fieldProblem(f: FormField, value: FormValue | undefined): string | undefined {
  switch (f.type) {
    case "external":
      return undefined
    case "boolean":
      return undefined
    case "multiselect": {
      const list = Array.isArray(value) ? value : []
      if (f.minItems !== undefined && list.length < f.minItems) return `Choose at least ${f.minItems}`
      if (f.required && !list.length) return "Required"
      if (f.maxItems !== undefined && list.length > f.maxItems) return `Choose at most ${f.maxItems}`
      return undefined
    }
    case "number":
    case "integer": {
      const raw = text(value)
      if (!raw) return f.required ? "Required" : undefined
      const n = Number(raw)
      if (!Number.isFinite(n)) return "Enter a number"
      if (f.type === "integer" && !Number.isInteger(n)) return "Enter a whole number"
      if (f.minimum !== undefined && n < f.minimum) return `At least ${f.minimum}`
      if (f.maximum !== undefined && n > f.maximum) return `At most ${f.maximum}`
      return undefined
    }
    case "string": {
      const raw = text(value)
      if (!raw) return f.required ? "Required" : undefined
      if (f.options?.length && !f.custom && !f.options.some((o) => o.value === raw)) return "Choose one of the options"
      if (f.minLength !== undefined && raw.length < f.minLength) return `At least ${f.minLength} characters`
      if (f.maxLength !== undefined && raw.length > f.maxLength) return `At most ${f.maxLength} characters`
      if (f.pattern) {
        try {
          if (!new RegExp(f.pattern).test(raw)) return "Doesn't match the expected format"
        } catch {
          // a pattern this browser cannot compile is checked by OpenCode
        }
      }
      return undefined
    }
  }
}

/** OpenCode's answer for the visible fields: trimmed text, numbers, booleans, chosen options; empty text left out. */
export function formAnswer(fields: readonly FormField[], values: FormValues): FormAnswer {
  const out: FormAnswer = {}
  for (const f of visibleFields(fields, values)) {
    const value = values[f.key]
    if (f.type === "external") continue
    if (f.type === "boolean") out[f.key] = value === true
    else if (f.type === "multiselect") out[f.key] = Array.isArray(value) ? [...value] : []
    else {
      const raw = text(value)
      if (!raw) continue
      out[f.key] = f.type === "number" || f.type === "integer" ? Number(raw) : raw
    }
  }
  return out
}
