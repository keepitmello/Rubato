import { closeSync, openSync, readFileSync, readSync } from "node:fs"

// A dream reads what happened in a project since the last dream. It reads each user turn as two
// parts: what the user said, and the assistant's last reply of that turn. The user's words carry the
// decisions and the raw symptoms; the closing reply is where the assistant explained to a person what
// it found and why. What happens in between (tool calls, intermediate narration, results) is progress,
// and progress is what turned the first dreams into status boards. Measured on one day of sessions:
// 213k characters with tool lines kept, ~72k this way.

export interface SessionHeader {
  readonly id: string
  readonly cwd: string
  readonly startedAt: string
}

export interface CondensedSession {
  readonly header: SessionHeader
  readonly name?: string
  readonly lastAt?: string
  readonly markdown: string
  /** Messages newer than `since`. Zero means the session has nothing new to read. */
  readonly messages: number
}

type Json = Record<string, unknown>

/** Reads only the first line: scanning every session in the profile must not load 20 MB files. */
export function readSessionHeader(path: string): SessionHeader | undefined {
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(8192)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return readSessionHeaderFromLine(buffer.subarray(0, read).toString("utf8").split("\n", 1)[0])
  } finally {
    closeSync(fd)
  }
}

export function condenseSession(path: string, sinceMs: number): CondensedSession | undefined {
  const lines = readFileSync(path, "utf8").split("\n")
  const header = readSessionHeaderFromLine(lines[0])
  if (header === undefined) return undefined
  let name: string | undefined
  let lastAt: string | undefined
  let messages = 0
  const parts: string[] = []
  let reply: string | undefined
  const closeTurn = () => {
    if (reply !== undefined) parts.push(`\n## assistant\n\n${reply}\n`)
    reply = undefined
  }
  for (const line of lines) {
    const entry = parseLine(line)
    if (entry === undefined) continue
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name
    if (entry.type !== "message" || !isRecord(entry.message)) continue
    const at = typeof entry.timestamp === "string" ? entry.timestamp : undefined
    if (at === undefined || Date.parse(at) <= sinceMs) continue
    messages += 1
    lastAt = at
    const message = entry.message
    const text = joinText(Array.isArray(message.content) ? message.content.filter(isRecord) : [])
    if (message.role === "user") {
      closeTurn()
      if (text !== "") parts.push(`\n## user\n\n${text}\n`)
    } else if (message.role === "assistant" && text !== "") {
      reply = text
    }
  }
  closeTurn()
  const title = `# ${name ?? header.id}\n\ncwd: ${header.cwd}\nsession: ${header.id}\n`
  return {
    header,
    ...(name === undefined ? {} : { name }),
    ...(lastAt === undefined ? {} : { lastAt }),
    markdown: [title, ...parts].join("\n"),
    messages,
  }
}

function joinText(content: readonly Json[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter((text) => text !== "")
    .join("\n\n")
}

function readSessionHeaderFromLine(line: string | undefined): SessionHeader | undefined {
  const entry = parseLine(line)
  if (entry?.type !== "session" || typeof entry.cwd !== "string" || typeof entry.id !== "string") return undefined
  return { id: entry.id, cwd: entry.cwd, startedAt: typeof entry.timestamp === "string" ? entry.timestamp : "" }
}

function parseLine(line: string | undefined): Json | undefined {
  if (line === undefined || line.trim() === "") return undefined
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
