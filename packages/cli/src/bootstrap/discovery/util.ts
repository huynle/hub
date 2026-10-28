// Small path and text helpers shared by discovery and preview.
import { isAbsolutePath } from "../contracts/index.ts"

/** A normalized absolute path (duplicate and trailing slashes removed), or undefined. */
export function normalizeAbs(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined
  const p = value.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1")
  return isAbsolutePath(p) ? p : undefined
}

export const join = (dir: string, rel: string) => (dir === "/" ? `/${rel}` : `${dir}/${rel}`)
export const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "")
export const oneLine = (v: string | undefined, max = 64) => (v && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined)
