// The side panel of a companion's room (intent memory-redesign-work-cards, outcome 2; mockup room):
// what the companion keeps, beside its conversation, in four tabs —
//   Status board  its open items (memory/status.md)
//   Questions     what it wants to ask the person, answerable here
//   Memory        what it knows about the person and about the two of them, searchable
//   Records       its dated records (daily, diary, weekly) and the people and companies it knows
// It reads the companion's records through the memory service (state/rubatoSegnoMemory.ts) and never
// writes them: an answer goes into the conversation as the person's message, and a line the person
// wants changed or forgotten is put in the composer for them to finish and send, so the companion
// makes the change itself (lead decision: Segno's records change only through Segno).
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, CheckIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import {
  answerText,
  changeRequestText,
  rubatoSegnoMemory,
  type SegnoMemoryView,
  type SegnoQuestion,
  useCompanionSender,
} from "../../state/rubatoSegnoMemory";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";

export type SegnoPanelTab = "status" | "questions" | "memory" | "records";
export const SEGNO_PANEL_TABS: ReadonlyArray<{ readonly id: SegnoPanelTab; readonly label: string }> = [
  { id: "status", label: "Status board" },
  { id: "questions", label: "Questions" },
  { id: "memory", label: "Memory" },
  { id: "records", label: "Records" },
];

/** How often the panel reads the records again while it shows; the companion commits as it goes. */
const POLL_MS = 10_000;
const OPEN_KEY = "rubato:segno-panel";

/** Whether the panel is open; it starts open and remembers the person's choice. */
export function useSegnoPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Private mode: the choice lasts this session.
    }
  }, []);
  return [open, set];
}

const lastViews = new Map<string, SegnoMemoryView>();

function useSegnoMemory(environmentId: EnvironmentId | null, companionId: string) {
  const key = `${environmentId}:${companionId}`;
  const [view, setView] = useState<SegnoMemoryView | null>(() => lastViews.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoSegnoMemory.memory(environmentId, companionId);
      lastViews.set(key, next);
      setView(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId, companionId, key]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { view, error, refresh };
}

/** Open questions: not yet answered from here, suggestions for its prompt left out. */
export function openQuestionCount(view: SegnoMemoryView | null): number {
  return view?.questions?.items.filter((item) => !item.proposal && !item.sent).length ?? 0;
}

/** "2026-11-08" → "11-08"; an ISO time → its local month and day. */
export function shortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${day[1]}-${day[2]}`;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function RubatoSegnoPanel({
  environmentId,
  companionId,
  companionTitle,
  threadId,
  onClose,
}: {
  environmentId: EnvironmentId | null;
  companionId: string;
  companionTitle: string;
  threadId: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SegnoPanelTab>("status");
  const { view, error, refresh } = useSegnoMemory(environmentId, companionId);
  // A line the person wants changed goes to the composer, quoted, for them to say what to change.
  const askToChange = useCallback(
    (line: string) => {
      if (environmentId === null || threadId === null) return;
      const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
      useComposerDraftStore.getState().setPrompt(ref, changeRequestText(line, ""));
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-rubato-segno-chat] [contenteditable="true"]')?.focus(),
      );
    },
    [environmentId, threadId],
  );
  const questions = openQuestionCount(view);
  return (
    <aside
      data-rubato-segno-side-panel=""
      aria-label={`${companionTitle}'s records`}
      className="flex h-full min-h-0 w-[23rem] shrink-0 flex-col border-border border-s bg-background"
    >
      <div className="flex shrink-0 items-center gap-1 border-border border-b px-2.5 pt-[3.1rem] pb-2" role="tablist">
        {SEGNO_PANEL_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-rubato-segno-panel-tab={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[.8rem] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === item.id ? "bg-primary/12 font-semibold text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{item.label}</span>
            {item.id === "questions" && questions > 0 ? (
              <span className="font-semibold text-warning tabular-nums" translate="no">
                {questions}
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ms-auto flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
        >
          <XIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel" data-rubato-segno-panel-body={tab}>
        {view === null ? (
          <p className="px-4 py-3 text-muted-foreground text-xs">{error ?? "Loading…"}</p>
        ) : !view.exists ? (
          <p className="px-4 py-3 text-muted-foreground text-xs">{companionTitle} keeps no records yet.</p>
        ) : tab === "status" ? (
          <StatusTab view={view} onAsk={askToChange} />
        ) : tab === "questions" ? (
          <QuestionsTab view={view} environmentId={environmentId} companionId={companionId} onSent={refresh} />
        ) : tab === "memory" ? (
          <MemoryTab view={view} environmentId={environmentId} companionId={companionId} companionTitle={companionTitle} onAsk={askToChange} />
        ) : (
          <RecordsTab view={view} environmentId={environmentId} companionId={companionId} />
        )}
      </div>
    </aside>
  );
}

function Row({ children, onClick, title }: { children: ReactNode; onClick?: (() => void) | undefined; title?: string }) {
  const className = "block w-full border-border border-b px-4 py-2.5 text-left text-[.83rem] leading-snug";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(className, "cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
    >
      {children}
    </button>
  ) : (
    <div className={className}>{children}</div>
  );
}

function Meta({ parts }: { parts: ReadonlyArray<string | null | undefined> }) {
  const shown = parts.filter((part): part is string => Boolean(part));
  if (shown.length === 0) return null;
  return (
    <span className="mt-0.5 block text-muted-foreground text-xs">
      {shown.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          <span>{part}</span>
        </span>
      ))}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-muted-foreground text-xs leading-relaxed">{children}</p>;
}

function StatusTab({ view, onAsk }: { view: SegnoMemoryView; onAsk: (line: string) => void }) {
  const sections = view.status?.sections ?? [];
  if (sections.length === 0) return <Hint>The status board is empty.</Hint>;
  return (
    <div data-rubato-segno-status="">
      {sections.map((section, index) => (
        <section key={`${section.title}:${index}`}>
          {section.title ? (
            <h3 className="bg-muted/40 px-4 pt-2.5 pb-1 font-medium text-muted-foreground text-xs" translate="no">
              {section.title}
            </h3>
          ) : null}
          {section.items.map((item) => (
            <Row key={item.id} onClick={() => onAsk(item.text)} title="Ask to change">
              <span translate="no">{item.text}</span>
              <Meta parts={[item.refs]} />
            </Row>
          ))}
        </section>
      ))}
      <Hint>
        Updated {shortDate(view.status?.updatedAt) ?? "—"}. Click a line to ask for a change; the request goes into the
        composer.
      </Hint>
    </div>
  );
}

function QuestionsTab({
  view,
  environmentId,
  companionId,
  onSent,
}: {
  view: SegnoMemoryView;
  environmentId: EnvironmentId | null;
  companionId: string;
  onSent: () => void;
}) {
  const sender = useCompanionSender(environmentId, companionId);
  const items = view.questions?.items ?? [];
  const ordered = useMemo(
    () => [...items.filter((item) => !item.proposal && !item.sent), ...items.filter((item) => item.proposal || item.sent)],
    [items],
  );
  if (items.length === 0) return <Hint>No questions right now.</Hint>;
  return (
    <div data-rubato-segno-questions="">
      {ordered.map((question) => (
        <QuestionRow key={question.id} question={question} sender={sender} onSent={onSent} />
      ))}
      <Hint>An answer goes into this conversation as your message.</Hint>
    </div>
  );
}

function QuestionRow({
  question,
  sender,
  onSent,
}: {
  question: SegnoQuestion;
  sender: ReturnType<typeof useCompanionSender>;
  onSent: () => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNow, setSentNow] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (answering) area.current?.focus();
  }, [answering]);
  const sent = sentNow ?? question.sent ?? null;
  const send = async () => {
    if (busy || answer.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await sender.send(answerText(question.text, answer), question.id);
      setSentNow(new Date().toISOString());
      setAnswering(false);
      setAnswer("");
      onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-rubato-segno-question={question.id} data-sent={sent ? "" : undefined} className="border-border border-b px-4 py-2.5 text-[.83rem]">
      <p className={cn("leading-snug", sent && "text-muted-foreground")} translate="no">
        {question.text}
      </p>
      <Meta parts={[question.proposal ? "Suggestion" : null, question.refs, sent ? `Answered ${shortDate(sent)}` : null]} />
      {answering ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea
            ref={area}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            rows={3}
            aria-label="Answer"
            className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          <div className="flex gap-1.5">
            <Button size="xs" disabled={busy || answer.trim() === "" || !sender.ready} onClick={() => void send()}>
              Send
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setAnswering(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => setAnswering(true)}>
            {sent ? "Answer again" : "Answer"}
          </Button>
          {sentNow ? (
            <span className="flex items-center gap-1 text-success text-xs">
              <CheckIcon aria-hidden="true" className="size-3.5" />
              Sent
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MemoryTab({
  view,
  environmentId,
  companionId,
  companionTitle,
  onAsk,
}: {
  view: SegnoMemoryView;
  environmentId: EnvironmentId | null;
  companionId: string;
  companionTitle: string;
  onAsk: (line: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<{ path: string; line: number; text: string }> | null>(null);
  useEffect(() => {
    const term = query.trim();
    if (term === "" || environmentId === null) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void rubatoSegnoMemory
        .search(environmentId, term, companionId)
        .then((answer) => live && setResults(answer.results))
        .catch(() => live && setResults([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, environmentId, companionId]);
  return (
    <div data-rubato-segno-memory="">
      <div className="relative px-3 py-2.5">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${companionTitle}'s memory`}
          className="w-full rounded-lg border border-input bg-background py-1.5 ps-8 pe-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      {results !== null ? (
        results.length === 0 ? (
          <Hint>Nothing found.</Hint>
        ) : (
          results.map((result) => (
            <Row key={`${result.path}:${result.line}`} onClick={() => onAsk(result.text)} title="Ask to change">
              <span translate="no">{result.text}</span>
              <Meta parts={[result.path]} />
            </Row>
          ))
        )
      ) : view.about.length === 0 ? (
        <Hint>Nothing kept about you yet.</Hint>
      ) : (
        view.about.map((line) => (
          <Row key={line.id} onClick={() => onAsk(line.text)} title="Ask to change">
            <span translate="no">{line.text}</span>
            <Meta parts={[line.kind === "user" ? "About you" : "Between us", line.refs, line.sent ? `Asked ${shortDate(line.sent)}` : shortDate(line.updatedAt)]} />
          </Row>
        ))
      )}
      <Hint>Click a line and the request to change or forget it goes into the composer. Send it, and {companionTitle} makes the change.</Hint>
    </div>
  );
}

function RecordsTab({
  view,
  environmentId,
  companionId,
}: {
  view: SegnoMemoryView;
  environmentId: EnvironmentId | null;
  companionId: string;
}) {
  const [reading, setReading] = useState<{ path: string; label: string } | null>(null);
  if (reading) return <RecordReader {...reading} environmentId={environmentId} companionId={companionId} onBack={() => setReading(null)} />;
  return (
    <div data-rubato-segno-records="">
      {view.records.length === 0 && view.weekly.length === 0 ? <Hint>No records yet.</Hint> : null}
      {view.weekly.slice(0, 2).map((week) => (
        <Row key={week.path} onClick={() => setReading({ path: week.path, label: week.week })}>
          <span className="flex gap-3">
            <span className="w-12 shrink-0 text-muted-foreground tabular-nums" translate="no">
              {week.week.slice(5)}
            </span>
            <span className="min-w-0">
              <span className="line-clamp-2" translate="no">
                {week.headline || week.week}
              </span>
              <Meta parts={["Weekly"]} />
            </span>
          </span>
        </Row>
      ))}
      {view.records.map((day) => (
        <div key={day.date} className="flex border-border border-b px-4 py-2.5 text-[.83rem] leading-snug">
          <span className="w-12 shrink-0 text-muted-foreground tabular-nums" translate="no">
            {shortDate(day.date)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2" translate="no">
              {day.headline || day.date}
            </span>
            <span className="mt-1 flex gap-1.5">
              {day.daily ? (
                <Button size="xs" variant="outline" onClick={() => setReading({ path: day.daily!, label: day.date })}>
                  Daily record
                </Button>
              ) : null}
              {day.diary ? (
                <Button size="xs" variant="outline" onClick={() => setReading({ path: day.diary!, label: day.date })}>
                  Diary
                </Button>
              ) : null}
            </span>
          </span>
        </div>
      ))}
      {view.entities.length > 0 ? (
        <section className="px-4 py-3">
          <h3 className="mb-2 flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
            <span>People and companies</span>
            <span className="tabular-nums" translate="no">
              {view.entities.length}
            </span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {view.entities.map((entity) => (
              <button
                key={entity.path}
                type="button"
                title={entity.summary ?? undefined}
                onClick={() => setReading({ path: entity.path, label: entity.name })}
                className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                translate="no"
              >
                {entity.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RecordReader({
  path,
  label,
  environmentId,
  companionId,
  onBack,
}: {
  path: string;
  label: string;
  environmentId: EnvironmentId | null;
  companionId: string;
  onBack: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    let live = true;
    void rubatoSegnoMemory
      .file(environmentId, path, companionId)
      .then((file) => live && setContent(file.content))
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [environmentId, path, companionId]);
  return (
    <div data-rubato-segno-record={path}>
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <ArrowLeftIcon />
        </button>
        <span className="truncate font-medium text-sm" translate="no">
          {label}
        </span>
      </div>
      <div className="px-4 py-3 text-sm">
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : content === null ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : (
          <ChatMarkdown text={content} cwd={undefined} />
        )}
      </div>
    </div>
  );
}
