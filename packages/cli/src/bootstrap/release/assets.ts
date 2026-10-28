// The embedded-asset bundle: the six service templates of EMBEDDED_ASSETS (contracts §3.7, I2), imported as text so
// `bun build --compile` (and the npm bundle) carry them inside the program. A standalone hubctl never reads
// scripts/ at run time; node.ts / spoke-services.ts render from embeddedAsset(id).text (wired by HBS-13).
//
// Each import must match EMBEDDED_ASSETS[id].source; the release tests check every entry byte for byte.
import { EMBEDDED_ASSETS, type EmbeddedAsset } from "../contracts/index.ts"
import { digestBytes } from "./verify.ts"
import launchdNode from "../../../../../scripts/io.github.huynle.hub-node.plist" with { type: "text" }
import systemdNode from "../../../../../scripts/hub-node.service" with { type: "text" }
import launchdClaude from "../../../../../scripts/io.github.huynle.hub-claude-code.plist" with { type: "text" }
import systemdClaude from "../../../../../scripts/hub-claude-code.service" with { type: "text" }
import launchdCodex from "../../../../../scripts/io.github.huynle.hub-codex-spoke.plist" with { type: "text" }
import systemdCodex from "../../../../../scripts/hub-codex-spoke.service" with { type: "text" }

export type AssetID = keyof typeof EMBEDDED_ASSETS

/** The template text of every embedded asset, by EMBEDDED_ASSETS id. */
export const EMBEDDED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "service/launchd/node": launchdNode,
  "service/systemd-user/node": systemdNode,
  "service/launchd/claude-code": launchdClaude,
  "service/systemd-user/claude-code": systemdClaude,
  "service/launchd/codex-spoke": launchdCodex,
  "service/systemd-user/codex-spoke": systemdCodex,
})

export interface EmbeddedText {
  readonly asset: EmbeddedAsset
  readonly text: string
  /** "sha256:<hex>" of the template's UTF-8 bytes (a write-file action pins the rendered result instead). */
  readonly sha256: string
}

/** An embedded template with its contract entry and digest; undefined for any other id. */
export function embeddedAsset(id: string): EmbeddedText | undefined {
  if (!Object.hasOwn(EMBEDDED_ASSETS, id) || !Object.hasOwn(EMBEDDED_TEXT, id)) return undefined
  const text = EMBEDDED_TEXT[id]!
  return { asset: EMBEDDED_ASSETS[id]!, text, sha256: digestBytes(new TextEncoder().encode(text)).sha256 }
}
