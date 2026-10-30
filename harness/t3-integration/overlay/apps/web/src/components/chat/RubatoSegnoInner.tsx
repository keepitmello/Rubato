// What the companion did between the room's bubbles (user f8828a9f): one quiet line that opens in
// place. The line under a reply holds the work behind it; a line of its own holds work that led to
// no reply (a heartbeat, a greeting it kept to itself); the line under the writing dots is what it
// does right now. The room stays a chat log of the person's messages and the companion's replies:
// these pieces are read from the conversation's session file when the room asks (bridge
// companion/inner.mjs), never written into the thread, so nothing here reaches the phone.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { rubatoCompanion, type SegnoInnerItem, type SegnoSpanSummary } from "../../state/rubatoCompanion";
import { spanCounts, spanDuration, type SegnoSpanPlace } from "./rubatoSegnoRoom";

/** How often an open line that runs on now asks again. */
const LIVE_POLL_MS = 2_500;

/** What woke the companion, as the open line names it (keeper.mjs notify `what`). */
const WAKE_LABELS: Readonly<Record<string, string>> = {
  heartbeat: "Heartbeat",
  greeting: "Greeting",
  wake: "Woke up",
  recall: "Recalling",
  sleep: "Going to sleep",
  inbox: "Work room",
  "persona-review": "Persona review",
};

function clock(at: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

/** A long piece shows its first lines until it is opened. */
function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  return (
    <div data-rubato-segno-clamped={long && !open ? "" : undefined}>
      <p className="whitespace-pre-wrap break-words">{text}</p>
      {long ? (
        <button type="button" data-rubato-segno-more="" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<SegnoInnerItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const state = item.done === undefined ? "running" : item.isError ? "failed" : "done";
  return (
    <div data-rubato-segno-tool="" data-state={state}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span data-rubato-segno-tool-name="">{item.name}</span>
        {item.summary ? <span data-rubato-segno-tool-summary="">{item.summary}</span> : null}
        <span data-rubato-segno-tool-state="" aria-label={state} />
      </button>
      {open ? (
        <div data-rubato-segno-tool-detail="">
          {item.input ? <pre>{item.input}</pre> : null}
          {item.output ? <pre data-output="">{item.output}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function Piece({ item, locale }: { item: SegnoInnerItem; locale: string | undefined }) {
  switch (item.kind) {
    case "thinking":
    case "text":
    case "error":
      return <Clamped text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "wake":
      return (
        <details data-rubato-segno-wake="">
          <summary>
            {WAKE_LABELS[item.what] ?? "Woke up"} <span>{clock(item.at, locale)}</span>
          </summary>
          {item.text ? <p className="whitespace-pre-wrap break-words">{item.text}</p> : null}
        </details>
      );
    case "message":
      return (
        <div data-rubato-segno-from="">
          <span data-rubato-segno-from-name="">{item.from || "Another conversation"}</span>
          <Clamped text={item.text} />
        </div>
      );
    case "compaction":
      return <div data-rubato-segno-compaction="">Context compacted</div>;
  }
}

/** A key per piece that stays put as the span grows: a tool by its call, the rest by kind, time and order. */
function pieceKeys(items: readonly SegnoInnerItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    if (item.kind === "tool" && item.id) return `tool:${item.id}`;
    const base = `${item.kind}:${item.at}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}:${count}`;
  });
}

export function RubatoSegnoSpanPieces({ items, locale }: { items: readonly SegnoInnerItem[]; locale: string | undefined }) {
  const keys = pieceKeys(items);
  return (
    <div data-rubato-segno-inner-panel="">
      {items.map((item, index) => (
        <div key={keys[index]} data-rubato-segno-piece={item.kind}>
          <Piece item={item} locale={locale} />
        </div>
      ))}
    </div>
  );
}

export function RubatoSegnoSpanLine(props: {
  place: SegnoSpanPlace;
  summary: SegnoSpanSummary | null | undefined;
  companionId: string | undefined;
  environmentId: EnvironmentId | undefined;
  locale: string | undefined;
}) {
  const { place, summary, companionId, environmentId, locale } = props;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<readonly SegnoInnerItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const live = place.placement === "live";
  const runsOn = place.until === null;
  const version = summary ? `${summary.from}:${summary.to}:${summary.tools}:${summary.thinking}:${summary.text}` : "";

  useEffect(() => {
    if (!open || !environmentId || !companionId) return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const answer = await rubatoCompanion.innerItems(environmentId, companionId, place.after, place.until);
        if (stopped) return;
        setItems(answer.items);
        setFailed(false);
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped && runsOn) timer = window.setTimeout(load, LIVE_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // A span that ends at a bubble is read again only when its summary moved.
  }, [open, environmentId, companionId, place.after, place.until, runsOn, version]);

  const empty = !summary || summary.from === null;
  if (empty && !live) return null;
  const counts = summary && !empty ? spanCounts(summary) : [];
  const duration =
    summary && summary.from !== null && summary.to !== null ? spanDuration(summary.to - summary.from, locale) : null;

  return (
    <div data-rubato-segno-span="" data-placement={place.placement} data-open={open ? "" : undefined}>
      <button type="button" data-rubato-segno-span-line="" aria-expanded={open} onClick={() => setOpen(!open)}>
        {place.placement === "quiet" ? <span data-rubato-segno-rule="" aria-hidden="true" /> : null}
        <span data-rubato-segno-chevron="" aria-hidden="true" />
        {live ? <span data-rubato-segno-live-dot="" aria-hidden="true" /> : null}
        {live ? <span data-part="">Working now</span> : null}
        {/* A line of its own leads with how long the companion was at it; under a reply, what it did comes first. */}
        {duration && place.placement === "quiet" ? <span data-part="">{duration}</span> : null}
        {counts.map((word) => (
          <span key={word} data-part="">
            {word}
          </span>
        ))}
        {duration && place.placement === "attached" ? <span data-part="">{duration}</span> : null}
        {place.placement === "quiet" ? <span data-rubato-segno-rule="" aria-hidden="true" /> : null}
      </button>
      {open ? (
        items === null ? (
          <div data-rubato-segno-inner-panel="" data-loading="">
            {failed ? "Could not read this part of the conversation." : "Loading…"}
          </div>
        ) : items.length === 0 ? (
          <div data-rubato-segno-inner-panel="" data-loading="">
            Nothing yet.
          </div>
        ) : (
          <RubatoSegnoSpanPieces items={items} locale={locale} />
        )
      ) : null}
    </div>
  );
}

/**
 * The summary of every span of the room, asked again when the bubbles change and every so often
 * while the room is open, more often while the companion is working.
 */
export function useSegnoSpanSummaries(input: {
  environmentId: EnvironmentId | undefined;
  companionId: string | undefined;
  boundaries: readonly number[];
  after: number | undefined;
  working: boolean;
}): ReadonlyArray<SegnoSpanSummary | null> {
  const { environmentId, companionId, after, working } = input;
  const [spans, setSpans] = useState<ReadonlyArray<SegnoSpanSummary | null>>([]);
  // The bubble times as one value, so a new array of the same times asks nothing again.
  const key = input.boundaries.join(",");
  useEffect(() => {
    if (!environmentId || !companionId) return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const answer = await rubatoCompanion.inner(environmentId, companionId, key ? key.split(",").map(Number) : [], after);
          if (!stopped) setSpans(answer.spans);
        } catch {
          // The bridge is restarting or older than this room: the lines stay as they were.
        }
      }
      if (!stopped) timer = window.setTimeout(load, working ? 3_000 : 15_000);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [environmentId, companionId, key, after, working]);
  return spans;
}
