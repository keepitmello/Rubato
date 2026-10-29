// What the shared user store holds, read for people and for checks. One record is one markdown file
// answering one question about the user, under a topic folder:
//
//   ---
//   description: <one English line>
//   ---
//   ## Conclusion
//   - <the current answer, English>
//   ## Scope
//   - <only when it holds narrowly>
//   ## Evidence
//   - <YYYY-MM-DD> · <where: project `x` | Settings > Memory | legacy profile> · "<the user's words, verbatim>"
//
// The curators (user-dream-persona.md, user-ask-persona.md) write this shape; a file that strays still
// reads, with whatever parts it has.

import type { Git } from "../dream/runner"

export interface EvidenceLine {
  readonly raw: string
  readonly date?: string
  readonly where?: string
  readonly quote?: string
}

export interface UserRecord {
  readonly path: string
  readonly blob: string
  /** Top folder: the topic the record is filed under ("" for a file at the root). */
  readonly topic: string
  readonly description: string | null
  readonly conclusion: readonly string[]
  readonly scope: readonly string[]
  readonly evidence: readonly EvidenceLine[]
  readonly text: string
}

export function topicOf(path: string): string {
  const slash = path.indexOf("/")
  return slash < 0 ? "" : path.slice(0, slash)
}

export function parseRecord(path: string, text: string, blob = ""): UserRecord {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const descriptionLine = front?.[1]?.split(/\r?\n/).find((line) => /^description\s*:/.test(line))
  const description = descriptionLine?.replace(/^description\s*:\s*/, "").trim().replace(/^(['"])(.*)\1$/, "$2") || null
  const body = front === null ? text : text.slice(front[0].length)
  const sections = new Map<string, string[]>()
  let current: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      current = heading[1]!.toLowerCase()
      sections.set(current, [])
    } else if (current !== undefined) sections.get(current)!.push(line)
  }
  const bullets = (name: string) => (sections.get(name) ?? [])
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
  return {
    path,
    blob,
    topic: topicOf(path),
    description,
    conclusion: bullets("conclusion"),
    scope: bullets("scope"),
    evidence: bullets("evidence").map(parseEvidence),
    text,
  }
}

export function parseEvidence(raw: string): EvidenceLine {
  const quoteStart = raw.search(/["“「『]/)
  const quote = quoteStart < 0 ? undefined : unquote(raw.slice(quoteStart))
  const head = (quoteStart < 0 ? raw : raw.slice(0, quoteStart)).split(/\s+·\s+|\s+—\s+/).map((part) => part.trim().replace(/[·—:]\s*$/, "").trim()).filter(Boolean)
  const date = head[0] !== undefined && /^\d{4}-\d{2}-\d{2}/.test(head[0]) ? head.shift()!.slice(0, 10) : undefined
  const where = head.length > 0 ? head.join(" · ").replaceAll("`", "") : undefined
  return { raw, ...(date === undefined ? {} : { date }), ...(where === undefined ? {} : { where }), ...(quote === undefined ? {} : { quote }) }
}

function unquote(text: string): string {
  const trimmed = text.trim()
  const pairs: Record<string, string> = { '"': '"', "“": "”", "「": "」", "『": "』" }
  const close = pairs[trimmed[0]!]
  if (close === undefined) return trimmed
  const end = trimmed.lastIndexOf(close)
  return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1)
}

/** Every markdown record at `revision`, with its blob id: what the summary is matched against. */
export async function listRecords(git: Git, repo: string, revision = "HEAD"): Promise<UserRecord[]> {
  const tree = await git(repo, ["ls-tree", "-r", "-z", revision])
  if (tree.code !== 0) return []
  const records: UserRecord[] = []
  for (const entry of tree.stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t")
    const [, type, blob] = entry.slice(0, tab).split(" ")
    const path = entry.slice(tab + 1)
    if (type !== "blob" || !path.endsWith(".md") || blob === undefined) continue
    const shown = await git(repo, ["cat-file", "blob", blob])
    if (shown.code === 0) records.push(parseRecord(path, shown.stdout, blob))
  }
  return records.sort((a, b) => a.path.localeCompare(b.path))
}

/** The line a person reads for a record when no summary line matches it: its conclusion, else its description. */
export function plainLine(record: UserRecord): string {
  return record.conclusion[0] ?? record.description ?? record.path
}
