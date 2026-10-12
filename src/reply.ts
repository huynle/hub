interface MessageLike {
  readonly id: string
  readonly type: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> | null
}

const textOf = (message: MessageLike) =>
  (message.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("")
    .trim()

/**
 * The spoken answer to a prompt: the text of the last assistant message after the prompt's
 * user message. Tool-only final messages fall back to the latest earlier assistant text.
 */
export function extractReply(messages: ReadonlyArray<MessageLike>, userMessageID: string): string {
  const start = messages.findIndex((message) => message.id === userMessageID)
  if (start === -1) return ""
  const assistants = messages.slice(start + 1).filter((message) => message.type === "assistant")
  for (let index = assistants.length - 1; index >= 0; index--) {
    const text = textOf(assistants[index]!)
    if (text) return text
  }
  return ""
}
