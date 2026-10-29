import type { UserMemoryAsk, UserMemoryChange, UserMemoryEvidence, UserMemoryItem, UserMemoryView } from "../../state/rubatoMemory";

/** A topic's heading: the title the curator wrote in the user's language, else the folder in words. */
export function topicTitle(topic: { readonly id: string; readonly title: string | null }): string {
  if (topic.title) return topic.title;
  if (topic.id === "") return "Other";
  const words = topic.id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a remembered line came from, in words a person knows. */
export function evidenceSource(evidence: UserMemoryEvidence): string {
  const where = evidence.where ?? "";
  if (/settings\s*>\s*memory/i.test(where)) return "You told Rubato here";
  if (/legacy profile/i.test(where)) return "Your old profile";
  const project = /^project\s+(.+)$/i.exec(where)?.[1];
  if (project) return `Said in ${project}`;
  return where || "Noticed in a conversation";
}

/** One line under a remembered item: how much it rests on and when it was last said. */
export function itemBasis(item: Pick<UserMemoryItem, "evidence">): string | null {
  const said = item.evidence.filter((entry) => entry.quote !== undefined).length;
  const latest = item.evidence.map((entry) => entry.date).filter((date): date is string => Boolean(date)).toSorted().at(-1);
  if (said === 0) return latest ? `Last noted ${latest}` : null;
  const times = said === 1 ? "From something you said" : `From ${said} things you said`;
  return latest ? `${times} · latest ${latest}` : times;
}

const CHANGE_WORD: Record<UserMemoryChange["change"], string> = {
  added: "Now remembered",
  modified: "Changed",
  deleted: "Forgotten",
  renamed: "Moved",
};

export function changeWord(change: UserMemoryChange): string {
  return CHANGE_WORD[change.change];
}

/** The request still being handled, if any: the composer waits for it. */
export function workingAsk(asks: readonly UserMemoryAsk[]): UserMemoryAsk | null {
  return asks.find((ask) => ask.state === "working") ?? null;
}

/** How soon to look again: often while a request is handled, slowly while a dream updates the memory. */
export function pollDelay(view: Pick<UserMemoryView, "asks" | "dream"> | null): number | null {
  if (view === null) return null;
  if (workingAsk(view.asks)) return 2_000;
  if (view.dream.running) return 15_000;
  return null;
}

/**
 * When to read the memory again: soon after a failed refresh (whatever was going on), often while a
 * request the server accepted is not in the view yet, else as `pollDelay` says. Nothing before the first read.
 */
export function refreshDelay(view: Pick<UserMemoryView, "asks" | "dream"> | null, refreshFailed: boolean, acceptedNotShown: number): number | null {
  if (view === null) return null;
  if (refreshFailed) return 5_000;
  if (acceptedNotShown > 0) return 2_000;
  return pollDelay(view);
}

const JUST_MS = 15 * 60 * 1000;

/**
 * Records the newest finished request changed, marked in the list so the result shows in place: a request
 * sent from this page, or one that finished in the last few minutes. Forgotten lines are not marked here.
 */
export function justChanged(asks: readonly UserMemoryAsk[], sentHere: ReadonlySet<string> = new Set(), now = Date.now()): ReadonlyMap<string, UserMemoryChange> {
  const latest = asks.find((ask) => ask.state !== "working");
  const recent = latest !== undefined && (sentHere.has(latest.id) || now - Date.parse(latest.result?.finishedAt ?? "") < JUST_MS);
  const changes = latest?.state === "done" && recent ? latest.result?.changes ?? [] : [];
  return new Map(changes.filter((change) => change.change !== "deleted").map((change) => [change.path, change]));
}

/** What the page asks the model when a person presses an action on a remembered line. */
export function presetRequest(kind: "why" | "forget"): string {
  return kind === "why" ? "Why do you remember this? What did I say?" : "Forget this.";
}

const FAILURES = {
  busy: "Another request was still being handled.",
  noModel: "No model is set for memory. Pick one in the Settings tab here.",
  forgotten: "The change would have brought back something you asked to forget.",
  stillThere: "It could not remove every copy of that, so nothing was forgotten.",
  raced: "Your memory changed while this was being handled. Try again.",
  stopped: "The request stopped before it finished.",
} as const;

/** The failure sentences this page writes itself (interface text, translated); anything else is shown as it came. */
export const FAILURE_TEXTS: ReadonlySet<string> = new Set(Object.values(FAILURES));

/** Why a request did not go through, without the machinery around it. */
export function failureText(ask: UserMemoryAsk): string {
  if (ask.state === "busy") return FAILURES.busy;
  const reason = (ask.result?.reason ?? "").split("\n")[0]!.trim();
  if (/no model configured/i.test(reason)) return FAILURES.noModel;
  if (/asked to forget/i.test(reason)) return FAILURES.forgotten;
  if (/still in /i.test(reason)) return FAILURES.stillThere;
  if (/merge failed|conflict/i.test(reason)) return FAILURES.raced;
  if (reason === "" || /stopped before it finished/i.test(reason)) return FAILURES.stopped;
  return reason;
}

/** Summary sentence at the top: how much is remembered, in how many topics. */
export function overviewLine(view: Pick<UserMemoryView, "count" | "topics">): string {
  if (view.count === 0) return "Nothing is remembered about you yet.";
  const things = view.count === 1 ? "1 thing" : `${view.count} things`;
  const topics = view.topics.length === 1 ? "1 topic" : `${view.topics.length} topics`;
  return `Rubato remembers ${things} about you, in ${topics}.`;
}

const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;

/**
 * Which requests the thread under the composer shows up front, and which fold under "earlier".
 * Up front: what was sent from this page (unless it is answered on its own line), anything still
 * working, and a recent failure nobody has retried yet. A failure retried with the same words is gone.
 */
export function threadAsks(
  asks: readonly UserMemoryAsk[],
  sentHere: ReadonlySet<string>,
  shownInline: ReadonlySet<string>,
  now: number,
): { readonly current: UserMemoryAsk[]; readonly earlier: UserMemoryAsk[] } {
  const sameRequest = (a: UserMemoryAsk, b: UserMemoryAsk) => a.text === b.text && (a.focus?.path ?? null) === (b.focus?.path ?? null);
  const retried = (ask: UserMemoryAsk) => asks.some((other) => other.createdAt > ask.createdAt && sameRequest(other, ask));
  const current: UserMemoryAsk[] = [];
  const earlier: UserMemoryAsk[] = [];
  for (const ask of asks) {
    if (shownInline.has(ask.id)) continue;
    const failed = ask.state === "failed" || ask.state === "busy";
    if (failed && retried(ask)) continue;
    const recentFailure = failed && now - Date.parse(ask.createdAt) < RECENT_FAILURE_MS;
    if (sentHere.has(ask.id) || ask.state === "working" || recentFailure) current.push(ask);
    else earlier.push(ask);
  }
  return { current, earlier };
}

const PROBLEM_TEXT: Record<NonNullable<UserMemoryAsk["result"]>["problems"] extends ReadonlyArray<infer P> | undefined ? P : never, string> = {
  "reply-lost": "Saved, but Rubato stopped before it could reply. This is what changed.",
  "summary-stale": "Saved. Its summary line catches up on the next dream; until then the list shows the saved wording.",
  "changes-unread": "Saved, but what changed could not be read back. The list shows your memory as it is now.",
  "forget-unrecorded": "Removed, but Rubato could not note it as forgotten, so an old conversation might bring it back.",
};

/** What a landed request still owes the person, in words; empty when everything after the save finished. */
export function problemTexts(ask: UserMemoryAsk): string[] {
  return (ask.result?.problems ?? []).map((problem) => PROBLEM_TEXT[problem]).filter(Boolean);
}

/**
 * Lines forgotten from this page, one row per line: the newest request that actually deleted it (a later
 * correction of the same line, or an older request about it, does not make a second row).
 */
export function forgottenRows(asks: readonly UserMemoryAsk[], sentHere: ReadonlySet<string>, present: ReadonlySet<string>): UserMemoryAsk[] {
  const seen = new Set<string>();
  const rows: UserMemoryAsk[] = [];
  for (const ask of asks) {
    const path = ask.focus?.path;
    if (!path || seen.has(path) || present.has(path) || !sentHere.has(ask.id) || ask.state !== "done") continue;
    if (!ask.result?.changes.some((change) => change.path === path && change.change === "deleted")) continue;
    seen.add(path);
    rows.push(ask);
  }
  return rows;
}

export function needsForgetRecorded(ask: UserMemoryAsk): boolean {
  return (ask.result?.problems ?? []).includes("forget-unrecorded");
}
