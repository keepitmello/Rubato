import { open } from "node:fs/promises"

const INITIAL_TAIL_BYTES = 64 * 1024

// Whether the child's last turn stopped before the model answered: its session ends at an input
// (a prompt, a tool result, a model-visible custom message) or at a reply cut short. Bookkeeping
// entries a runtime writes as it shuts down (custom records, model or thinking changes) carry no
// conversation, so the decision reads past them to the last conversation entry. A drained restart
// (pi-server drain.mjs) leaves exactly that: the tool results, then the shutdown's own records.
export async function sessionTailNeedsContinuation(sessionPath: string): Promise<boolean> {
  try {
    const entry = await lastConversationEntry(sessionPath)
    if (entry === undefined) return false
    if (entry.type === "custom_message") return true
    const message = entry.message
    if (message.role === "user" || message.role === "toolResult") return true
    if (message.role !== "assistant") return false
    if (message.stopReason === "aborted") return true
    if (!Array.isArray(message.content)) return false
    return message.content.some((part) => isRecord(part) && part.type === "toolCall")
  } catch {
    return false
  }
}

// The last message or custom_message entry. Start with the normal 64 KiB tail and grow backwards
// while the window holds only bookkeeping or begins inside an oversized record. The final record
// itself is never skipped when it is malformed: it throws, and the caller does not continue rather
// than reinterpret an earlier user message as unanswered.
async function lastConversationEntry(sessionPath: string): Promise<ConversationEntry | undefined> {
  const file = await open(sessionPath, "r")
  try {
    const size = (await file.stat()).size
    if (size === 0) return undefined
    let bytes = Math.min(size, INITIAL_TAIL_BYTES)
    for (;;) {
      const start = size - bytes
      const buffer = Buffer.allocUnsafe(bytes)
      const { bytesRead } = await file.read(buffer, 0, bytes, start)
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)
      // A window that does not start at the file's start may begin mid-record.
      const first = start === 0 ? 0 : 1
      for (let index = lines.length - 1; index >= first; index -= 1) {
        const line = lines[index]!.trim()
        if (line.length === 0) continue
        const parsed = JSON.parse(line) as unknown
        if (isSessionMessageEntry(parsed) || isCustomMessageEntry(parsed)) return parsed
        if (!isRecord(parsed)) return undefined
      }
      if (start === 0) return undefined
      bytes = Math.min(size, bytes * 2)
    }
  } finally {
    await file.close()
  }
}

type ConversationEntry = SessionMessageEntry | { readonly type: "custom_message" }

function isCustomMessageEntry(value: unknown): value is { readonly type: "custom_message" } {
  return isRecord(value) && value.type === "custom_message"
}

type SessionMessageEntry = {
  readonly type: "message"
  readonly message: {
    readonly role?: string
    readonly content?: readonly unknown[]
    readonly stopReason?: string
  }
}

function isSessionMessageEntry(value: unknown): value is SessionMessageEntry {
  return isRecord(value) && value.type === "message" && isRecord(value.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
