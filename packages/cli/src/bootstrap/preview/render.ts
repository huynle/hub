// The preview for people. Paths under the home directory are shown as ~/…; the token's nonce is never printed.
import type { PathRef, SetupPreview } from "../contracts/index.ts"

const tilde = (path: string, home?: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path)
const ref = (r: PathRef) => `${r.root}:${r.rel}`

/** The preview for people: the steps, the consents apply will ask for, and each manual edit with the file it belongs in. */
export function renderPreview(preview: SetupPreview, home?: string): string[] {
  const { plan } = preview
  const lines = [`Setup plan for ${plan.target} (${plan.profile.id}), ${plan.actions.length} step(s):`]
  plan.actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a.summary}${a.escalation === "elevated" ? " [needs --escalate]" : ""}`))
  if (plan.requiresEscalation) lines.push("Apply needs --escalate: some steps write system locations.")
  if (plan.activatesServices) lines.push("Apply needs --confirm-activation: it loads user services.")
  for (const e of preview.evidence) lines.push(`Evidence ${e.kind} for ${e.actionID}: ${e.status}`)
  if (preview.blockers.length > 0) {
    lines.push(`${preview.blockers.length} change(s) must be made by hand, because hubctl will not write the config itself:`)
    for (const b of preview.blockers) {
      const why = b.linkPath ? `linked from ${tilde(b.linkPath, home)}` : "hubctl cannot edit this format losslessly"
      lines.push(`  - in ${tilde(b.resolvedPath, home)} (${why}, ${ref(b.path)}):`)
      const c = b.change
      if (c.op === "merge") for (const s of c.set) lines.push(`      set ${s.pointer} = ${JSON.stringify(s.value)}`)
      else if (c.op === "register-mcp-server") lines.push(`      register the hub MCP server "${c.name}" for ${c.harness} (hubctl mcp)`)
      else lines.push(`      write asset ${c.asset} (${c.sha256}, mode ${c.mode.toString(8)})`)
    }
    lines.push("Make these edits, then run the preview again.")
  }
  lines.push(`Plan ${preview.planDigest}; the preview expires at ${new Date(preview.token.expiresAt).toISOString()}.`)
  return lines
}

