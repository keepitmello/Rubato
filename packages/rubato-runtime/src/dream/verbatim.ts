// The user's own words in a memory file, which a translation must carry byte for byte.
//
// Memory is written in English, but what the user said stays in their language: the body of the
// symptom section (`## Symptom`, or `## 증상` before migration) and quoted text, inline or as a
// `>` block. "Quoted" is mechanical here so a runner can check it: a single-line span inside "…",
// “…”, ‘…’ or 「…」, or a `>` line, that contains Hangul. Text without Hangul is already English
// or code and is not at risk from a translation into English.

const HANGUL = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/
const HANGUL_ALL = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/g
export const SYMPTOM_HEADINGS = ["Symptom", "증상"] as const
const QUOTED = /"([^"\n]*)"|“([^”\n]*)”|‘([^’\n]*)’|「([^」\n]*)」/g
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/
const FENCE = /^\s{0,3}(```|~~~)/
const HEADING = /^(#{1,2})\s+(.*?)\s*#*\s*$/

export interface VerbatimSegments {
  /** Symptom section bodies, leading blank lines and trailing whitespace trimmed. */
  readonly symptoms: readonly string[]
  /** Quoted spans with Hangul, without their quote marks. */
  readonly quotes: readonly string[]
  /** `>` lines with Hangul, without the marker. */
  readonly blockquotes: readonly string[]
}

interface Line {
  readonly text: string
  readonly inFence: boolean
}

function lines(source: string): Line[] {
  const out: Line[] = []
  let fence: string | undefined
  for (const text of source.replace(/\r\n/g, "\n").split("\n")) {
    const marker = FENCE.exec(text)?.[1]
    if (marker !== undefined && (fence === undefined || fence === marker)) {
      out.push({ text, inFence: true })
      fence = fence === undefined ? marker : undefined
      continue
    }
    out.push({ text, inFence: fence !== undefined })
  }
  return out
}

function headingOf(line: Line): { level: number; title: string } | undefined {
  if (line.inFence) return undefined
  const match = HEADING.exec(line.text)
  return match === null ? undefined : { level: match[1]!.length, title: match[2]! }
}

/** `## Symptom`, `## 증상`, and qualified forms such as `## 증상 (수정 전)`. */
export function isSymptomHeading(title: string): boolean {
  return SYMPTOM_HEADINGS.some((name) => title === name || title.startsWith(`${name} `) || title.startsWith(`${name}(`))
}

function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "")
}

/** Bodies of every symptom section, in order. A section ends at the next `#` or `##` heading. */
export function symptomBodies(text: string): string[] {
  const all = lines(text)
  const bodies: string[] = []
  for (let index = 0; index < all.length; index += 1) {
    const heading = headingOf(all[index]!)
    if (heading === undefined || heading.level !== 2 || !isSymptomHeading(heading.title)) continue
    const body: string[] = []
    let next = index + 1
    for (; next < all.length; next += 1) {
      if (headingOf(all[next]!) !== undefined) break
      body.push(all[next]!.text)
    }
    bodies.push(normalizeBody(body.join("\n")))
    index = next - 1
  }
  return bodies
}

export function verbatimSegments(text: string): VerbatimSegments {
  const quotes: string[] = []
  const blockquotes: string[] = []
  for (const line of lines(text)) {
    const block = BLOCKQUOTE.exec(line.text)
    if (!line.inFence && block !== null && HANGUL.test(block[1]!)) blockquotes.push(block[1]!.trimEnd())
    for (const match of line.text.matchAll(QUOTED)) {
      const inner = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ""
      if (HANGUL.test(inner)) quotes.push(inner)
    }
  }
  return { symptoms: symptomBodies(text), quotes: unique(quotes), blockquotes: unique(blockquotes) }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * What `after` lost of the user's words in `before`: one line per problem, empty when every symptom
 * body survives byte for byte under a symptom heading and every quoted span and `>` line still appears.
 */
export function missingVerbatim(before: string, after: string): string[] {
  const was = verbatimSegments(before)
  const now = symptomBodies(after)
  const problems: string[] = []
  const left = [...now]
  for (const body of was.symptoms) {
    const at = left.indexOf(body)
    if (at >= 0) left.splice(at, 1)
    else problems.push(`symptom text changed or moved out of its section: ${clip(body)}`)
  }
  for (const quote of was.quotes) if (!after.includes(quote)) problems.push(`quoted text changed: ${clip(quote)}`)
  for (const quote of was.blockquotes) if (!after.includes(quote)) problems.push(`> quote changed: ${clip(quote)}`)
  return problems
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ")
  return one.length > 120 ? `${one.slice(0, 120)}…` : one
}

/**
 * Hangul a translation into English should have removed: everything outside code, symptom bodies,
 * quoted spans and `>` lines, headings included (so `## 증상` itself counts).
 */
export function translatableHangul(text: string): number {
  const all = lines(text)
  const symptomLines = new Set<number>()
  for (let index = 0; index < all.length; index += 1) {
    const heading = headingOf(all[index]!)
    if (heading === undefined || heading.level !== 2 || !isSymptomHeading(heading.title)) continue
    for (let next = index + 1; next < all.length && headingOf(all[next]!) === undefined; next += 1) symptomLines.add(next)
  }
  let count = 0
  for (const [index, line] of all.entries()) {
    if (line.inFence || symptomLines.has(index) || BLOCKQUOTE.test(line.text)) continue
    const prose = line.text.replace(/`[^`\n]*`/g, "").replace(QUOTED, "")
    count += prose.match(HANGUL_ALL)?.length ?? 0
  }
  return count
}

/** True when a file still has something for the English migration to do. */
export function needsTranslation(text: string): boolean {
  return translatableHangul(text) > 0
}

/**
 * Problems with one file's translation: lost user words, a Korean symptom heading left behind, or
 * most of the prose still untranslated. Empty means the file passes.
 */
export function translationProblems(before: string, after: string): string[] {
  const problems = missingVerbatim(before, after)
  if (lines(after).some((line) => /^증상(?:$|[ (])/.test(headingOf(line)?.title ?? ""))) problems.push("`## 증상` is still there; it becomes `## Symptom`")
  const was = translatableHangul(before)
  const left = translatableHangul(after)
  if (left > Math.max(30, Math.floor(was * 0.1))) problems.push(`still mostly Korean: ${left} of ${was} Hangul characters outside quotes and code remain`)
  return problems
}
