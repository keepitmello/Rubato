// The user's own words in a memory file, which a translation must carry byte for byte.
//
// Memory is written in English, but what the user said stays in their language: the body of the
// symptom section (`## Symptom`, or `## 증상` before migration) and quoted text, inline or as a
// `>` block. "Quoted" is mechanical here so a runner can check it: a single-line span inside "…",
// “…”, ‘…’, 「…」 or '…' (an apostrophe inside a word does not open one), or a `>` line, in any
// language. All of it must survive byte for byte; a translation can only add English around it.
// What the check cannot see is a sentence that keeps the quote and reverses its meaning.

const HANGUL_ALL = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/g
export const SYMPTOM_HEADINGS = ["Symptom", "증상"] as const
const QUOTED = /"([^"\n]*)"|“([^”\n]*)”|‘([^’\n]*)’|「([^」\n]*)」|(?<![\p{L}\p{N}])'([^'\n]*)'(?![\p{L}\p{N}])/gu
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/
const FENCE = /^\s{0,3}(```|~~~)/
const HEADING = /^(#{1,2})\s+(.*?)\s*#*\s*$/

export interface VerbatimSegments {
  /** Symptom section bodies, exact except for empty lines at either end. */
  readonly symptoms: readonly string[]
  /** Quoted spans, quote marks included. */
  readonly quotes: readonly string[]
  /** Non-empty `>` lines, without the marker. */
  readonly blockquotes: readonly string[]
}

interface Line {
  readonly text: string
  readonly inFence: boolean
}

function lines(source: string): Line[] {
  const out: Line[] = []
  let fence: string | undefined
  // Line endings stay as written ("\r" included): a changed line ending is a changed byte.
  for (const text of source.split("\n")) {
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

/** Empty lines at either end belong to the layout between headings, not to the text. */
function normalizeBody(lines: readonly string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && /^\r?$/.test(lines[start]!)) start += 1
  while (end > start && /^\r?$/.test(lines[end - 1]!)) end -= 1
  return lines.slice(start, end).join("\n")
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
    bodies.push(normalizeBody(body))
    index = next - 1
  }
  return bodies
}

export function verbatimSegments(text: string): VerbatimSegments {
  const quotes: string[] = []
  const blockquotes: string[] = []
  for (const line of lines(text)) {
    const block = BLOCKQUOTE.exec(line.text)
    if (!line.inFence && block !== null && block[1]!.trim() !== "") blockquotes.push(block[1]!)
    for (const match of line.text.matchAll(QUOTED)) {
      const inner = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ""
      // With its quote marks: a translation that turns “…” into "…" changed the user's text too.
      if (inner.trim() !== "") quotes.push(match[0])
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

/** Hangul outside code spans and quotes on one line. */
function proseHangul(line: string): number {
  return line.replace(/`[^`\n]*`/g, "").replace(QUOTED, "").match(HANGUL_ALL)?.length ?? 0
}

/** Headings and the frontmatter `description` that still carry Hangul outside quotes and code. */
function untranslatedLabels(text: string): string[] {
  const out: string[] = []
  const all = lines(text)
  const frontmatterEnd = all[0]?.text.replace(/\r$/, "") === "---" ? all.findIndex((line, index) => index > 0 && line.text.replace(/\r$/, "") === "---") : -1
  for (const [index, line] of all.entries()) {
    if (index < frontmatterEnd && /^description:/.test(line.text) && proseHangul(line.text) > 0) out.push("description")
    const heading = headingOf(line)
    if (heading !== undefined && proseHangul(heading.title) > 0) out.push(`heading "${heading.title}"`)
  }
  return out
}

/**
 * Problems with one file's translation: lost user words, a file left as it was, a Korean heading or
 * description left behind, or more than a few words of prose still untranslated. Empty means it passes.
 */
export function translationProblems(before: string, after: string): string[] {
  const problems = missingVerbatim(before, after)
  const was = translatableHangul(before)
  if (was > 0 && after === before) {
    problems.push("the file is unchanged; translate it")
    return problems
  }
  const labels = untranslatedLabels(after)
  if (labels.length > 0) problems.push(`still in Korean: ${labels.join(", ")}`)
  const left = translatableHangul(after)
  if (left > Math.max(10, Math.floor(was * 0.1))) problems.push(`still mostly Korean: ${left} of ${was} Hangul characters outside quotes and code remain`)
  return problems
}
