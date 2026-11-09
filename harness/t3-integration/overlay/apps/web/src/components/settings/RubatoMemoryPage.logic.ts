// The memory page's decisions that do not need React: what "needs you", how a project's week reads,
// where a companion's line about the person sits next to the shared memory, and how questions filter.
import type {
  MemoryFileEntry,
  MemoryInsights,
  MemoryOverlap,
  MemoryStoreSummary,
  ProjectChanges,
  UserMemoryView,
} from "../../state/rubatoMemory";
import type { SegnoAboutLine, SegnoMemoryView } from "../../state/rubatoSegnoMemory";

export type MemoryView = "home" | "me" | "projects" | "segno" | "dream";
export const MEMORY_VIEWS: readonly MemoryView[] = ["home", "me", "projects", "segno", "dream"];

/** The language the page asks the model to write in: the interface language. */
export function insightLanguage(uiLanguage: string | null): string {
  return uiLanguage === "ko" ? "Korean" : "English";
}

/** Stores that hold memory; an empty one is not memory and is not listed. */
export function listedStores<S extends Pick<MemoryStoreSummary, "empty" | "files">>(stores: readonly S[]): S[] {
  return stores.filter((store) => !(store.empty ?? store.files === 0));
}

export type NeedsYou =
  | { readonly kind: "question"; readonly id: string; readonly companionId: string; readonly text: string; readonly refs: string | null }
  | { readonly kind: "proposal"; readonly id: string; readonly companionId: string; readonly text: string; readonly refs: string | null }
  | { readonly kind: "overlap"; readonly id: string; readonly companionId: string; readonly overlap: MemoryOverlap; readonly line: string; readonly shared: string }
  | { readonly kind: "empty-stores"; readonly id: string; readonly stores: readonly string[] }
  | { readonly kind: "dream-failed"; readonly id: string; readonly store: string; readonly reason: string | null };

/**
 * What the person should look at, most actionable first: the companion's open questions, overlaps
 * between what it knows and the shared memory, its prompt proposals, dreams that failed, and stores
 * that hold nothing. `dismissed` holds ids the person put away on this device.
 */
export function needsYou(input: {
  readonly segno: SegnoMemoryView | null;
  readonly overlaps: readonly MemoryOverlap[];
  readonly user: Pick<UserMemoryView, "topics"> | null;
  readonly stores: readonly MemoryStoreSummary[];
  readonly dismissed: ReadonlySet<string>;
}): NeedsYou[] {
  const items: NeedsYou[] = [];
  const { segno } = input;
  if (segno?.questions) {
    for (const question of segno.questions.items) {
      if (question.sent) continue;
      items.push({ kind: question.proposal ? "proposal" : "question", id: question.id, companionId: segno.id, text: question.text, refs: question.refs });
    }
  }
  const lines = new Map((segno?.about ?? []).map((line) => [line.id, line]));
  const shared = new Map((input.user?.topics ?? []).flatMap((topic) => topic.items.map((item) => [item.path, item.text] as const)));
  for (const overlap of input.overlaps) {
    const line = lines.get(overlap.line);
    const sharedText = shared.get(overlap.shared);
    if (!line || sharedText === undefined || line.sent) continue;
    items.push({ kind: "overlap", id: `overlap:${overlap.line}:${overlap.shared}`, companionId: segno!.id, overlap, line: line.text, shared: sharedText });
  }
  for (const store of input.stores) {
    if (store.empty || store.lastRun?.status !== "failed") continue;
    items.push({ kind: "dream-failed", id: `dream:${store.store}:${store.lastRun.runId}`, store: store.store, reason: store.lastRun.reason ?? null });
  }
  if (segno?.dream?.lastStatus === "failed")
    items.push({ kind: "dream-failed", id: `dream:${segno.id}:${segno.dream.lastRunAt ?? ""}`, store: segno.title, reason: segno.dream.reason });
  const empty = input.stores.filter((store) => store.empty).map((store) => store.store).sort();
  if (empty.length > 0) items.push({ kind: "empty-stores", id: `empty:${empty.join(",")}`, stores: empty });
  const rank: Record<NeedsYou["kind"], number> = { question: 0, overlap: 1, proposal: 2, "dream-failed": 3, "empty-stores": 4 };
  return items
    .filter((item) => !input.dismissed.has(item.id))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank[a.item.kind] - rank[b.item.kind] || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The "needs you" card folded: the first `max` items with at most `perKind` of one kind, so a long
 * list of questions does not hide the overlaps and failures behind it. Order is kept.
 */
export function foldNeeds<T extends { readonly kind: string }>(items: readonly T[], max = 5, perKind = 2): T[] {
  const taken = new Map<string, number>();
  const shown: T[] = [];
  for (const item of items) {
    if (shown.length >= max) break;
    const n = taken.get(item.kind) ?? 0;
    if (n >= perKind) continue;
    taken.set(item.kind, n + 1);
    shown.push(item);
  }
  // Fewer kinds than room: fill up with the rest, still in order.
  for (const item of items) {
    if (shown.length >= max) break;
    if (!shown.includes(item)) shown.push(item);
  }
  return items.filter((item) => shown.includes(item));
}

export interface ChangeCounts {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

/** A project's week as counts per kind of answer: decisions, references, everything else. */
export function changeCounts(project: Pick<ProjectChanges, "files">): {
  readonly decision: ChangeCounts;
  readonly reference: ChangeCounts;
  readonly other: ChangeCounts;
} {
  const zero = () => ({ added: 0, modified: 0, deleted: 0 });
  const counts = { decision: zero(), reference: zero(), other: zero() };
  for (const file of project.files) {
    const bucket = file.kind === "decision" ? counts.decision : file.kind === "reference" ? counts.reference : counts.other;
    if (file.change === "added") bucket.added += 1;
    else if (file.change === "deleted") bucket.deleted += 1;
    else bucket.modified += 1;
  }
  return counts;
}

/**
 * The parts of a project's headline, as interface phrases with their number: "{0} decisions changed",
 * "{0} new" and so on. Zero counts are left out.
 */
export function changePhrases(project: Pick<ProjectChanges, "files">): Array<{ readonly phrase: string; readonly n: number }> {
  const counts = changeCounts(project);
  const phrases: Array<{ phrase: string; n: number }> = [];
  const add = (phrase: string, n: number) => {
    if (n > 0) phrases.push({ phrase, n });
  };
  add("{0} decisions changed", counts.decision.modified);
  add("{0} new decisions", counts.decision.added);
  add("{0} facts changed", counts.reference.modified);
  add("{0} new facts", counts.reference.added);
  add("{0} notes changed", counts.other.modified + counts.other.added);
  add("{0} removed", counts.decision.deleted + counts.reference.deleted + counts.other.deleted);
  return phrases;
}

/** The second line when no summary in the person's language is ready yet: the questions themselves. */
export function fallbackTopics(project: Pick<ProjectChanges, "files">, limit = 3): { readonly titles: readonly string[]; readonly more: number } {
  const titles = project.files
    .filter((file) => file.change !== "deleted")
    .map((file) => file.title ?? file.path.replace(/^.*\//, "").replace(/\.md$/, "").replaceAll("-", " "));
  return { titles: titles.slice(0, limit), more: Math.max(0, titles.length - limit) };
}

/** The summary line for a project when the cached one was written for this very week. */
export function projectLine(insights: Pick<MemoryInsights, "projects"> | null, store: string): string | null {
  const lines = insights?.projects.value?.lines;
  if (!lines || insights?.projects.stale) return null;
  return lines[store] ?? null;
}

export interface PlacedLines {
  /** Companion lines that sit right after a shared line, by the shared record's path. */
  readonly besideShared: ReadonlyMap<string, ReadonlyArray<{ readonly line: SegnoAboutLine; readonly overlap: MemoryOverlap }>>;
  /** Companion lines with no shared counterpart. */
  readonly alone: readonly SegnoAboutLine[];
}

/** Where each of a companion's lines about the person shows on the Me view. */
export function placeCompanionLines(lines: readonly SegnoAboutLine[], overlaps: readonly MemoryOverlap[], sharedPaths: ReadonlySet<string>): PlacedLines {
  const besideShared = new Map<string, Array<{ line: SegnoAboutLine; overlap: MemoryOverlap }>>();
  const placed = new Set<string>();
  for (const overlap of overlaps) {
    const line = lines.find((entry) => entry.id === overlap.line);
    if (!line || !sharedPaths.has(overlap.shared) || placed.has(line.id)) continue;
    placed.add(line.id);
    besideShared.set(overlap.shared, [...(besideShared.get(overlap.shared) ?? []), { line, overlap }]);
  }
  return { besideShared, alone: lines.filter((line) => !placed.has(line.id)) };
}

export type QuestionFilter = "all" | "decision" | "reference" | "recent";
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** A store's files as questions: filtered by kind or by recent change and by the search words, newest change first. */
export function filterQuestions(files: readonly MemoryFileEntry[], filter: QuestionFilter, query: string, now = Date.now()): MemoryFileEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return files
    .filter((file) => {
      if (filter === "decision" && file.kind !== "decision") return false;
      if (filter === "reference" && file.kind !== "reference") return false;
      if (filter === "recent" && !(file.changedAt && now - Date.parse(file.changedAt) < RECENT_MS)) return false;
      const haystack = `${file.path} ${file.title ?? ""} ${file.description ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .toSorted((a, b) => String(b.changedAt ?? "").localeCompare(String(a.changedAt ?? "")) || a.path.localeCompare(b.path));
}

/** A file's question as a person reads it: its heading, else its description, else its name. */
export function questionTitle(file: Pick<MemoryFileEntry, "path" | "title" | "description">): string {
  if (file.title) return file.title;
  if (file.description) return file.description;
  return file.path.replace(/^.*\//, "").replace(/\.md$/, "").replaceAll("-", " ");
}

/** Counts for the Me tile: shared lines per topic and the companion's own. */
export function meCounts(user: Pick<UserMemoryView, "topics" | "count"> | null, segno: Pick<SegnoMemoryView, "about"> | null) {
  return {
    shared: user?.count ?? 0,
    topics: (user?.topics ?? []).map((topic) => ({ id: topic.id, title: topic.title, n: topic.items.length })),
    companion: (segno?.about ?? []).filter((line) => line.kind === "user").length,
  };
}

/** The open items on a companion's status board: every line of its first section. */
export function openItems(segno: Pick<SegnoMemoryView, "status"> | null): number {
  return segno?.status?.sections[0]?.items.length ?? 0;
}

/** The oldest date a list of `refs` notes mentions, as MM-DD, for "oldest from 10-20". */
export function oldestRef(items: ReadonlyArray<{ readonly refs: string | null }>): string | null {
  const dates = items.flatMap((item) => [...(item.refs ?? "").matchAll(/\b(\d{2})-(\d{2})\b/g)].map((match) => `${match[1]}-${match[2]}`));
  return dates.length === 0 ? null : dates.toSorted()[0]!;
}
