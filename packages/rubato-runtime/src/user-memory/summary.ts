// The summary a person reads in Settings > Memory: topic titles and one line per record, in the user's
// language. It is a view of the store, never a second authority: each line is kept with the blob of the
// record it was written from, and a line whose record has since changed or gone is not shown (the
// record's own conclusion stands in until a curator writes a new line). Nothing here is indexed or
// loaded into a prompt.

import { readJsonFile, writeJsonFile, type UserStore } from "./store"

export interface SummaryCache {
  readonly language?: string
  /** Topic folder → title. */
  readonly topics: Readonly<Record<string, string>>
  /** Record path → the line and the blob it describes. */
  readonly items: Readonly<Record<string, { readonly blob: string; readonly text: string }>>
}

/** What a curator writes to `$OUT_DIR/summary.json` (or under `summary` in an ask's result.json). */
export interface SummaryOut {
  readonly language?: string
  readonly topics?: Readonly<Record<string, string>>
  readonly items?: Readonly<Record<string, string>>
}

export async function readSummary(store: UserStore): Promise<SummaryCache> {
  const cache = await readJsonFile<SummaryCache>(store.summary)
  return {
    ...(typeof cache?.language === "string" ? { language: cache.language } : {}),
    topics: stringMap(cache?.topics),
    items: Object.fromEntries(Object.entries(cache?.items ?? {}).filter(([, item]) =>
      item !== null && typeof item === "object" && typeof item.blob === "string" && typeof item.text === "string")),
  }
}

/**
 * The cache after a landing: lines for records that still exist at the same blob stay, the curator's new
 * lines attach to the blobs that landed, and lines for records that are gone drop.
 */
export function mergeSummary(cache: SummaryCache, out: SummaryOut | undefined, blobs: ReadonlyMap<string, string>): SummaryCache {
  const items: Record<string, { blob: string; text: string }> = {}
  for (const [path, item] of Object.entries(cache.items)) {
    if (blobs.get(path) === item.blob) items[path] = item
  }
  for (const [path, text] of Object.entries(stringMap(out?.items))) {
    const blob = blobs.get(path)
    if (blob !== undefined && text.trim() !== "") items[path] = { blob, text: text.trim() }
  }
  const folders = new Set([...blobs.keys()].map((path) => path.includes("/") ? path.slice(0, path.indexOf("/")) : ""))
  const topics = Object.fromEntries(Object.entries({ ...cache.topics, ...stringMap(out?.topics) })
    .filter(([folder, title]) => folders.has(folder) && title.trim() !== ""))
  const language = typeof out?.language === "string" && out.language.trim() !== "" ? out.language.trim() : cache.language
  return { ...(language === undefined ? {} : { language }), topics, items }
}

export async function writeSummary(store: UserStore, cache: SummaryCache): Promise<void> {
  await writeJsonFile(store.summary, cache)
}

function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}
