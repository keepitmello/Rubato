// A change the companion proposes to its own text or picture (intent companion-manage: "change by
// talking"). It rewrites a piece of who it is and shows the change as a card in its room; nothing
// is saved until the person presses apply (the Mac's apply-proposal), "더 고쳐줘" just keeps
// talking, and a newer proposal supersedes the open one. The Mac's `proposals` action lists them;
// a piece proposal carries the changed passage before and after, which the card shows as a word
// diff worked out here. No native module here, so tests read it.

/** stale: the passage is no longer in the text as it was, so the Mac will not apply it. */
export type ProposalStatus = "open" | "applied" | "declined" | "superseded" | "stale";

export type Proposal =
  | {
      readonly kind: "piece";
      readonly id: string;
      readonly createdAt: number;
      readonly status: ProposalStatus;
      /** Where it is, in the person's language (e.g. "세뇨는 이런 애야 › 말투"). */
      readonly label: string;
      readonly piece: string | null;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "avatar";
      readonly id: string;
      readonly createdAt: number;
      readonly status: ProposalStatus;
      readonly label: string;
      /** The drawn picture, as a URL the phone can show (a data URL from the Mac). */
      readonly image: string;
    };

const STATUSES: readonly ProposalStatus[] = ["open", "applied", "declined", "superseded", "stale"];

/**
 * One proposal from the Mac, or null for anything that does not read as one. A status this phone
 * does not know is left out: read as open it would offer to apply something the Mac closed.
 */
export function decodeProposal(value: unknown): Proposal | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.parse(String(item.createdAt));
  if (!Number.isFinite(createdAt)) return null;
  const status = item.status === undefined ? "open" : STATUSES.includes(item.status as ProposalStatus) ? (item.status as ProposalStatus) : null;
  if (status === null) return null;
  const label = typeof item.label === "string" ? item.label : "";
  if (item.kind === "avatar") {
    const url = (item.image as { url?: unknown } | null | undefined)?.url;
    return typeof url === "string" && url ? { kind: "avatar", id: item.id, createdAt, status, label, image: url } : null;
  }
  if (typeof item.before !== "string" || typeof item.after !== "string") return null;
  return {
    kind: "piece",
    id: item.id,
    createdAt,
    status,
    label,
    piece: typeof item.piece === "string" ? item.piece : null,
    before: item.before,
    after: item.after,
  };
}

export function decodeProposals(value: unknown): Proposal[] {
  const list = (value as { proposals?: unknown } | null)?.proposals;
  return Array.isArray(list) ? list.flatMap((item) => decodeProposal(item) ?? []) : [];
}

export type DiffSegment = { readonly kind: "same" | "del" | "ins"; readonly text: string };

/** Words and the spaces between them, each its own token, so a diff keeps the spacing as written. */
const tokens = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];

/** Past this many token pairs the table is too big for a phone; the card shows the passage swapped whole. */
const MAX_CELLS = 250_000;

/**
 * What changed from `before` to `after`, word by word (longest common subsequence of the tokens):
 * kept runs, removed words and added words, in reading order, removals before additions at a spot.
 */
export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokens(before);
  const b = tokens(after);
  const out: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };
  if (a.length * b.length > MAX_CELLS) {
    push("del", before);
    push("ins", after);
    return out;
  }
  // lengths[i][j]: the common run of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  let i = 0;
  let j = 0;
  let removed = "";
  let added = "";
  const flush = () => {
    push("del", removed);
    push("ins", added);
    removed = "";
    added = "";
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      push("same", a[i]!);
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      removed += a[i]!;
      i += 1;
    } else {
      added += b[j]!;
      j += 1;
    }
  }
  flush();
  return out;
}

/**
 * The diff as a card shows it: a long unchanged run keeps `context` characters next to each change
 * and an ellipsis for the rest, so a card about one sentence is not a page long.
 */
export function compactDiff(segments: readonly DiffSegment[], context = 40): DiffSegment[] {
  if (segments.length < 2) return [...segments];
  return segments.map((segment, index) => {
    if (segment.kind !== "same" || segment.text.length <= context * 2 + 1) return segment;
    const head = index === 0 ? "" : segment.text.slice(0, context);
    const tail = index === segments.length - 1 ? "" : segment.text.slice(-context);
    return { kind: "same", text: `${head}…${tail}` };
  });
}
