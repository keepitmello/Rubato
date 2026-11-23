// What the companion pages draw, worked out without React (intent companion-manage): the word diff
// of a proposal card, the round crop of a new picture, the one line under a companion in the list,
// the onboarding chips, where proposal cards stand among the room's bubbles, and the drafts that
// open a companion's room. The words here are English source text the interface translates
// (rubatoI18n); the drafts go into the composer as the person's own words, so they come in the
// interface's language already.

export interface WordDiffPart {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** Words and the spaces between them, each its own token, so a diff keeps the spacing as written. */
const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/gu) ?? [];

/** Past this many token pairs the diff gives up on matching and shows the whole excerpt replaced. */
const DIFF_CELLS_MAX = 4_000_000;

/**
 * Before → after as words: the shared words stay plain, a run of changed words shows what went and
 * then what came. A space between two changes joins them, so "한두 줄, 길어도 서너 줄" reads as one
 * struck run instead of word, space, word.
 */
export function wordDiff(before: string, after: string): WordDiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const raw: WordDiffPart[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  if (A.length * B.length > DIFF_CELLS_MAX) {
    raw.push(...A.map((text) => ({ kind: "removed" as const, text })), ...B.map((text) => ({ kind: "added" as const, text })));
  } else {
    const width = B.length + 1;
    const table = new Uint32Array((A.length + 1) * width);
    const at = (i: number, j: number) => table[i * width + j] ?? 0;
    for (let i = A.length - 1; i >= 0; i -= 1)
      for (let j = B.length - 1; j >= 0; j -= 1)
        table[i * width + j] = A[i] === B[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    let i = 0;
    let j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) {
        raw.push({ kind: "same", text: A[i]! });
        i += 1;
        j += 1;
      } else if (at(i + 1, j) >= at(i, j + 1)) raw.push({ kind: "removed", text: A[i++]! });
      else raw.push({ kind: "added", text: B[j++]! });
    }
    while (i < A.length) raw.push({ kind: "removed", text: A[i++]! });
    while (j < B.length) raw.push({ kind: "added", text: B[j++]! });
  }
  raw.push(...a.slice(endA).map((text) => ({ kind: "same" as const, text })));
  // A lone space between two changed runs belongs to both sides of the change.
  const joined: WordDiffPart[] = [];
  for (const [index, part] of raw.entries()) {
    const previous = raw[index - 1];
    const next = raw[index + 1];
    if (part.kind === "same" && /^\s+$/u.test(part.text) && previous && next && previous.kind !== "same" && next.kind !== "same") {
      joined.push({ kind: "removed", text: part.text }, { kind: "added", text: part.text });
    } else joined.push(part);
  }
  // Each changed run: everything removed, then everything added; neighbours of one kind merge.
  const out: WordDiffPart[] = [];
  const push = (kind: WordDiffPart["kind"], text: string) => {
    if (text === "") return;
    const last = out.at(-1);
    if (last && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };
  let removed = "";
  let added = "";
  const flush = () => {
    push("removed", removed);
    push("added", added);
    removed = "";
    added = "";
  };
  for (const part of joined) {
    if (part.kind === "removed") removed += part.text;
    else if (part.kind === "added") added += part.text;
    else {
      flush();
      push("same", part.text);
    }
  }
  flush();
  return out;
}

// ── The picture ───────────────────────────────────────────────────────────────────────────────

/** The longest side a picture is stored at (contract: square, at most 1024 px). */
export const AVATAR_MAX_PX = 1024;
/** The most a picture may weigh once decoded (contract: 2 MB). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** How far the crop may zoom in. */
export const CROP_ZOOM_MAX = 4;

export interface CropView {
  /** 1 = the largest square that fits the picture. */
  readonly zoom: number;
  /** The crop's center in the picture's own pixels. */
  readonly cx: number;
  readonly cy: number;
}

export interface CropSquare {
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Where the crop starts: the largest square, centered, except on a tall picture (a person standing)
 * where it sits at the top, where the face usually is.
 */
export function initialCrop(width: number, height: number): CropView {
  const side = Math.min(width, height);
  return { zoom: 1, cx: width / 2, cy: height > width * 1.2 ? side / 2 : height / 2 };
}

/** The square a view cuts out, kept inside the picture. */
export function cropSquare(width: number, height: number, view: CropView): CropSquare {
  const size = Math.min(width, height) / clamp(view.zoom, 1, CROP_ZOOM_MAX);
  const sx = clamp(view.cx - size / 2, 0, width - size);
  const sy = clamp(view.cy - size / 2, 0, height - size);
  return { sx, sy, size };
}

/** The view after a drag of (dx, dy) screen pixels on a preview `previewPx` wide: the picture follows the pointer. */
export function panCrop(width: number, height: number, view: CropView, dx: number, dy: number, previewPx: number): CropView {
  const { sx, sy, size } = cropSquare(width, height, view);
  const scale = size / Math.max(1, previewPx);
  const next = cropSquare(width, height, { ...view, cx: sx + size / 2 - dx * scale, cy: sy + size / 2 - dy * scale });
  return { ...view, cx: next.sx + next.size / 2, cy: next.sy + next.size / 2 };
}

/** The view at another zoom, around the same center. */
export function zoomCrop(width: number, height: number, view: CropView, zoom: number): CropView {
  const next = { ...view, zoom: clamp(zoom, 1, CROP_ZOOM_MAX) };
  const square = cropSquare(width, height, next);
  return { ...next, cx: square.sx + square.size / 2, cy: square.sy + square.size / 2 };
}

/** The side the stored picture gets: the crop's own pixels, never upscaled, at most AVATAR_MAX_PX. */
export function avatarSide(size: number): number {
  return Math.max(1, Math.min(AVATAR_MAX_PX, Math.round(size)));
}

/** The bytes a base64 data URL decodes to. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const data = comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** A data URL the picture route takes: jpeg, png or webp, within AVATAR_MAX_BYTES. */
export function acceptableAvatar(dataUrl: string): boolean {
  return /^data:image\/(jpeg|png|webp);base64,/u.test(dataUrl) && dataUrlBytes(dataUrl) <= AVATAR_MAX_BYTES;
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────

export interface CompanionListInput {
  readonly settings: { readonly enabled: boolean };
  readonly threadId: string | null;
  readonly onboarding?: CompanionOnboardingInput | null;
  readonly telegram?: boolean;
}

/** The parts of the line under a companion's name, each its own phrase so Korean finds it. */
export function companionListLine(item: CompanionListInput): string[] {
  if (!item.settings.enabled) return ["Off"];
  if (item.threadId === null) return ["Starting"];
  if (item.onboarding) return ["Getting to know you"];
  return item.telegram ? ["On", "Telegram"] : ["On"];
}

// ── Onboarding ────────────────────────────────────────────────────────────────────────────────

export interface CompanionOnboardingInput {
  readonly items: ReadonlyArray<{ readonly key: string; readonly state: "set" | "open" | "deferred"; readonly value?: string }>;
}

/** The onboarding's topics in the order the companion asks them (contract `onboarding.items`). */
export const ONBOARDING_KEYS = ["name", "callsUser", "work", "relationship", "look", "speech", "closeness"] as const;
/** The first four are what the companion needs before it settles; the rest may wait. */
export const ONBOARDING_REQUIRED: ReadonlySet<string> = new Set(ONBOARDING_KEYS.slice(0, 4));
const ONBOARDING_LABELS: Record<string, string> = {
  name: "Name",
  callsUser: "What it calls you",
  work: "Your work",
  relationship: "Your relationship",
  look: "Look",
  speech: "Speech",
  closeness: "Closeness",
};

export interface OnboardingChip {
  readonly key: string;
  readonly label: string;
  readonly state: "set" | "open" | "deferred";
  readonly required: boolean;
  readonly value?: string;
}

/** One chip per topic, in the companion's order; a topic the engine did not list yet is open. */
export function onboardingChips(onboarding: CompanionOnboardingInput | null | undefined): OnboardingChip[] {
  if (!onboarding) return [];
  const known: readonly string[] = ONBOARDING_KEYS;
  const byKey = new Map(onboarding.items.map((item) => [item.key, item]));
  const keys = [...known, ...onboarding.items.map((item) => item.key).filter((key) => !known.includes(key))];
  return keys.map((key) => {
    const item = byKey.get(key);
    return {
      key,
      label: ONBOARDING_LABELS[key] ?? key,
      state: item?.state ?? "open",
      required: ONBOARDING_REQUIRED.has(key),
      ...(item?.value ? { value: item.value } : {}),
    };
  });
}

// ── Proposals in the room ─────────────────────────────────────────────────────────────────────

export interface ProposalLike {
  readonly id: string;
  readonly createdAt: number;
  readonly status: "open" | "applied" | "declined" | "superseded" | "stale";
}

/** A replaced proposal leaves the room (the one that replaced it says the same, newer), and so do
 * proposals older than the room's first drawn message. */
export function shownProposals<P extends ProposalLike>(proposals: ReadonlyArray<P>, from: number | null): P[] {
  return proposals.filter((proposal) => proposal.status !== "superseded" && (from === null || proposal.createdAt >= from));
}

/** Each card stands before the first bubble written after it; later ones close the room. */
export function proposalPlacement<P extends ProposalLike>(
  bubbles: ReadonlyArray<{ readonly id: string; readonly at: number }>,
  proposals: ReadonlyArray<P>,
) {
  const before = new Map<string, P[]>();
  const tail: P[] = [];
  for (const proposal of [...proposals].sort((a, b) => a.createdAt - b.createdAt)) {
    const next = bubbles.find((bubble) => bubble.at > proposal.createdAt);
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), proposal]);
    else tail.push(proposal);
  }
  return { before, tail };
}

// ── Drafts that open the room ─────────────────────────────────────────────────────────────────

export type CompanionDraft = "who" | "me" | "sum-up-who" | "sum-up-me" | "draw" | "draw-icon" | "again";

const DRAFTS: Record<CompanionDraft, { readonly en: string; readonly ko: string }> = {
  who: { en: "About the card on who you are: ", ko: "너 소개 카드 말인데, " },
  me: { en: "About the card on what you know about me: ", ko: "네가 아는 나 카드 말인데, " },
  "sum-up-who": { en: "Could you sum up who you are for your card?", ko: "너는 어떤 애인지 카드로 정리해 줄래?" },
  "sum-up-me": { en: "Could you sum up what you know about me for your card?", ko: "네가 아는 나를 카드로 정리해 줄래?" },
  draw: { en: "Could you draw a new profile picture of yourself? ", ko: "새 프사 하나 그려 줄래? " },
  "draw-icon": { en: "Could you make a new sidebar icon for yourself? ", ko: "너 사이드바 아이콘 하나 만들어 줄래? " },
  again: { en: "That change no longer fits the current text. Could you show it again? ", ko: "아까 고친 거 지금 글이랑 안 맞는대. 다시 맞춰서 보여 줄래? " },
};

/** What the composer starts with; the person finishes it and sends it themselves. */
export function companionDraft(kind: CompanionDraft, language: "en" | "ko"): string {
  return DRAFTS[kind][language];
}

// ── Lines with the companion's name in them ───────────────────────────────────────────────────
// Korean particles follow the name's last sound (세뇨는 / 루크는 / 미룬은), which a dictionary
// template cannot know, so these lines are made here in the interface's language and drawn as is.

/** Whether a Korean word ends in a consonant (받침); a name in another script reads as if not. */
export function endsInConsonant(word: string): boolean {
  const last = Array.from(word.trim()).at(-1);
  if (!last) return false;
  const code = last.codePointAt(0)!;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

export type CompanionLine = "who-title" | "me-title" | "calls-user";

export function companionLine(kind: CompanionLine, name: string, language: "en" | "ko"): string {
  const consonant = endsInConsonant(name);
  if (language === "ko") {
    if (kind === "who-title") return `${name}${consonant ? "은" : "는"} 이런 애야`;
    if (kind === "me-title") return `${name}${consonant ? "이" : "가"} 아는 나`;
    return `나를 ${name}${consonant ? "이라고" : "라고"} 불러`;
  }
  if (kind === "who-title") return `Who ${name} is`;
  if (kind === "me-title") return `What ${name} knows about me`;
  return `Calls you ${name}`;
}

/** "Together since October 20" (with the year when it is not this year), or null for no date. */
export function sinceLine(since: string | null | undefined, language: "en" | "ko", now = new Date()): string | null {
  if (!since) return null;
  const at = /^\d{4}-\d{2}-\d{2}$/u.test(since) ? new Date(`${since}T12:00:00`) : new Date(since);
  if (Number.isNaN(at.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) };
  const date = new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", options).format(at);
  return language === "ko" ? `${date}부터 함께` : `Together since ${date}`;
}
