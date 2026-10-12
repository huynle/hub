// Types for web/picker-core.js (plain ES module used by the PWA without a build step).

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

export function pickerOptions(raw: unknown): PickerOption[]
export function filterPicker(options: readonly PickerOption[] | undefined, query: string, opts?: { current?: string; limit?: number }): PickerResult
export function stepActive(active: number, delta: number | "home" | "end", count: number): number
