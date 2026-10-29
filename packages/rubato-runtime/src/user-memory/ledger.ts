// What the user asked to forget. Deleting the record is the forgetting; this ledger keeps it gone. A
// later dream may read an old transcript, a project dream started before the forget may finish after
// it, a request may race a dream. Each entry names the forgotten claim in English and the distinctive
// words (in every language they were said in) that would only show up if it came back. Those words
// filter what a dream is given and are checked again, against the store as it is at that moment, before
// anything lands. Saying it again after the forget counts: evidence newer than the entry passes.

import { readJsonFile, writeJsonFile, type UserStore } from "./store"

export interface Tombstone {
  readonly what: string
  readonly terms: readonly string[]
  /** When the user asked; evidence from before this cannot bring it back. */
  readonly at: string
  readonly askId?: string
}

export interface Ledger {
  readonly forgotten: readonly Tombstone[]
}

export async function readLedger(store: UserStore): Promise<Ledger> {
  const ledger = await readJsonFile<Ledger>(store.ledger)
  return { forgotten: Array.isArray(ledger?.forgotten) ? ledger.forgotten.filter(isTombstone) : [] }
}

export async function addTombstones(store: UserStore, entries: readonly Tombstone[]): Promise<void> {
  if (entries.length === 0) return
  const current = await readLedger(store)
  await writeJsonFile(store.ledger, { forgotten: [...current.forgotten, ...entries] })
}

export function foldText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
}

/** The tombstone terms `text` contains. */
export function matchedTerms(text: string, tombstone: Tombstone): string[] {
  const folded = foldText(text)
  return tombstone.terms.filter((term) => foldText(term).trim() !== "" && folded.includes(foldText(term).trim()))
}

/** The first tombstone `text` would bring back, given when it was said (unknown time counts as before every forget). */
export function blockingTombstone(text: string, saidAt: string | undefined, ledger: Ledger): Tombstone | undefined {
  const said = saidAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(saidAt)
  return ledger.forgotten.find((entry) => {
    const forgotAt = Date.parse(entry.at)
    if (Number.isFinite(said) && Number.isFinite(forgotAt) && said > forgotAt) return false
    return matchedTerms(text, entry).length > 0
  })
}

function isTombstone(value: unknown): value is Tombstone {
  if (value === null || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.what === "string" && typeof entry.at === "string" && Array.isArray(entry.terms)
    && entry.terms.every((term) => typeof term === "string")
}
