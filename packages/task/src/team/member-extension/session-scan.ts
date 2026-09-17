import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

// Detects whether a delivered peer_message envelope has landed in the member's session JSONL.
// This is the delivery ack the self-poller uses before committing a reservation.
export async function sessionJsonlContainsMessage(sessionDir: string, messageId: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).toSorted()
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }

  for (const entry of entries) {
    const text = await readFile(join(sessionDir, entry), "utf8")
    for (const line of text.split("\n")) {
      const value = parseJsonLine(line)
      if (containsEnvelopeMarker(value, messageId)) return true
    }
  }
  return false
}

export function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function parseJsonLine(line: string): unknown {
  if (line.trim().length === 0) return undefined
  try {
    return JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function containsEnvelopeMarker(value: unknown, messageId: string): boolean {
  if (value === undefined || value === null) return false
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text.includes("<peer_message")) return false
  return text.includes(`messageId="${messageId}"`) || text.includes(`"messageId":"${messageId}"`)
}
