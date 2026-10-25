// Check "permission" (judgment; the runner provokes the request and answers it). A reply the hub sends is applied
// (once: the tool runs; reject: it does not), answered ok (not "gone": the request was pending), and followed by a
// permission.replied event for the request (with the reply, when the spoke names it).
import type { Answer } from "./deliver.ts"

export interface PermissionOutcome {
  readonly decision: "once" | "reject"
  /** The spoke's answer to the permission op (undefined: none). */
  readonly answer: Answer
  /** The permission.replied event for the request (undefined: none seen). */
  readonly replied: { readonly reply?: string } | undefined
  /** What the tool the request was for did, as the spoke's tool events tell (undefined: no tool event). */
  readonly tool: "success" | "failed" | undefined
}

export function permissionProblems(o: PermissionOutcome): string[] {
  const problems: string[] = []
  if (!o.answer) problems.push(`no answer to the ${o.decision} reply`)
  else if (!o.answer.ok) problems.push(`the ${o.decision} reply was refused: ${o.answer.error ?? "no error message"}`)
  else if ((o.answer.result as { gone?: unknown } | undefined)?.gone === true) problems.push(`the ${o.decision} reply came back "gone" although the request was pending`)
  if (!o.replied) problems.push(`no permission.replied event after the ${o.decision} reply`)
  else if (o.replied.reply !== undefined && o.replied.reply !== o.decision) problems.push(`permission.replied says ${JSON.stringify(o.replied.reply)} for a ${JSON.stringify(o.decision)} reply`)
  if (o.decision === "once" && o.tool === "failed") problems.push("the once reply was not applied: the tool failed")
  if (o.decision === "reject" && o.tool === "success") problems.push("the reject reply was not applied: the tool ran anyway")
  return problems
}
