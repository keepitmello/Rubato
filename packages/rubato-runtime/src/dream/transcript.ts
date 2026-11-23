import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs"

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
  /** The user's turns that were read, with when each was said: where a quoted fact about the user gets its time. */
  readonly userTurns: readonly UserTurn[]
}

export interface UserTurn {
  readonly at: string
  readonly text: string
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

// The engine appends timestamped entries in order. Most "changed" files only gained metadata
// after their last conversation, so inspect the tail rather than parsing whole sessions on startup.
export function hasUnreadConversation(path: string, sinceMs: number): boolean {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - 32_768)
    const tail = Buffer.alloc(size - start)
    const length = readSync(fd, tail, 0, tail.length, start)
    const lines = tail.toString("utf8", 0, length).split("\n")
    for (let index = lines.length - 1; index >= (start === 0 ? 0 : 1); index--) {
      const turn = conversation(parseLine(lines[index]))
      if (turn !== undefined) return Date.parse(turn.at) > sinceMs
    }
    return start !== 0 && (condenseSession(path, sinceMs)?.messages ?? 0) > 0
  } finally {
    closeSync(fd)
  }
}

function conversation(entry: Json | undefined) {
  if (entry?.type !== "message" || !isRecord(entry.message) || typeof entry.timestamp !== "string") return undefined
  const { role, content } = entry.message
  if ((role !== "user" && role !== "assistant") || !Number.isFinite(Date.parse(entry.timestamp))) return undefined
  const text = typeof content === "string" ? content.trim() : joinText(Array.isArray(content) ? content.filter(isRecord) : [])
  return text === "" ? undefined : { at: entry.timestamp, role, text }
}

export function condenseSession(path: string, sinceMs: number): CondensedSession | undefined {
  const lines = readFileSync(path, "utf8").split("\n")
  const header = readSessionHeaderFromLine(lines[0])
  if (header === undefined) return undefined
  let name: string | undefined
  let lastAt: string | undefined
  let messages = 0
  const parts: string[] = []
  const userTurns: UserTurn[] = []
  let reply: string | undefined
  const closeTurn = () => {
    if (reply !== undefined) parts.push(`\n## assistant\n\n${reply}\n`)
    reply = undefined
  }
  for (const line of lines) {
    const entry = parseLine(line)
    if (entry === undefined) continue
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name
    const turn = conversation(entry)
    if (turn === undefined || Date.parse(turn.at) <= sinceMs) continue
    const { at, role, text } = turn
    messages += 1
    lastAt = at
    if (role === "user") {
      closeTurn()
      if (text !== "") {
        parts.push(`\n## user · ${at}\n\n${text}\n`)
        userTurns.push({ at, text })
      }
    } else {
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
    userTurns,
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
