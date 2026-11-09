// Segno: what it holds for the person (status board), what it wants to ask, what it keeps about the
// two of them, its dated records and the people and companies it knows. Read-only: answering a
// question or asking for a change goes to Segno's conversation as the person's message.
import { BookOpenIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { uiText } from "../../rubatoI18n";
import {
  answerText,
  changeRequestText,
  rubatoSegnoMemory,
  useCompanionSender,
  type SegnoCommit,
  type SegnoLine,
  type SegnoMemoryView,
} from "../../state/rubatoSegnoMemory";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { oldestRef, openItems } from "./RubatoMemoryPage.logic";
import type { MemoryPageData } from "./RubatoMemoryPage";
import { AnswerBox, ago, Dots, MemoryCard, MemoryRow, monthDay, Muted, Tag, ViewHeading } from "./RubatoMemoryParts";
import { DiffView } from "./RubatoMemorySettings";

export type SegnoTarget = { readonly path: string };

const RECORDS_SHOWN = 10;

export function SegnoView({
  data,
  target,
  onTarget,
}: {
  data: MemoryPageData;
  target: SegnoTarget | null;
  onTarget: (target: SegnoTarget | null) => void;
}) {
  const [companions, setCompanions] = useState<ReadonlyArray<{ id: string; title: string; hasMemory: boolean }>>([]);
  const [companionId, setCompanionId] = useState(data.segno?.id ?? "segno");
  const [other, setOther] = useState<SegnoMemoryView | null>(null);
  useEffect(() => {
    void rubatoSegnoMemory.companions(data.environmentId).then((result) => setCompanions(result.companions), () => undefined);
  }, [data.environmentId]);
  useEffect(() => {
    if (companionId === (data.segno?.id ?? "segno")) {
      setOther(null);
      return;
    }
    let cancelled = false;
    rubatoSegnoMemory.memory(data.environmentId, companionId).then(
      (view) => {
        if (!cancelled) setOther(view);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [companionId, data.environmentId, data.segno?.id]);
  const view = other ?? (companionId === (data.segno?.id ?? "segno") ? data.segno : null);
  const reload = other ? async () => setOther(await rubatoSegnoMemory.memory(data.environmentId, companionId)) : data.reloadSegno;
  const choices = companions.filter((entry) => entry.hasMemory);

  if (data.segnoError && !view) return <p className="text-sm text-destructive-foreground">{data.segnoError}</p>;
  if (!view)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </p>
    );
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ViewHeading title={view.title} sub={`What ${view.title} holds and records. Only ${view.title} reads it; it changes when you tell ${view.title}.`} />
        {choices.length > 1 ? (
          <div className="flex gap-1" role="group" aria-label="Companion">
            {choices.map((entry) => (
              <Button
                key={entry.id}
                size="xs"
                variant={entry.id === companionId ? "secondary" : "ghost"}
                onClick={() => {
                  setCompanionId(entry.id);
                  onTarget(null);
                }}
              >
                <span translate="no">{entry.title}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {target ? <RecordReader data={data} companionId={view.id} path={target.path} onClose={() => onTarget(null)} /> : null}
      <SegnoBody data={data} view={view} onRead={(path) => onTarget({ path })} onChanged={reload} />
    </>
  );
}

function SegnoBody({
  data,
  view,
  onRead,
  onChanged,
}: {
  data: MemoryPageData;
  view: SegnoMemoryView;
  onRead: (path: string) => void;
  onChanged: () => Promise<void>;
}) {
  const sender = useCompanionSender(data.environmentId, view.id);
  const [showAll, setShowAll] = useState(false);
  const questions = view.questions?.items ?? [];
  const us = view.about.filter((line) => line.kind === "us");
  const diaries = view.records.filter((day) => day.diary).length;
  const records = showAll ? view.records : view.records.slice(0, RECORDS_SHOWN);
  const send = async (text: string, itemId: string) => {
    await sender.send(text, itemId);
    toastManager.add({ type: "success", title: `Sent to ${view.title}`, description: uiText(`${view.title} reads it in its conversation.`) });
    await onChanged();
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Status board" value={`${openItems(view)} open`} sub={view.status?.updatedAt ? `Updated ${ago(view.status.updatedAt)}` : ""} />
        <Stat
          label="Questions for you"
          value={String(questions.filter((item) => !item.proposal && !item.sent).length)}
          sub={oldestRef(questions) ? `Oldest from ${oldestRef(questions)}` : ""}
        />
        <Stat
          label="Records"
          value={`${view.records.length} days`}
          sub={<Dots parts={[`${diaries} diary days`, `${view.weekly.length} weeks`, `${view.entities.length} people and companies`]} />}
        />
      </div>

      {!sender.ready ? (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {`${view.title} is not in the app right now, so answers cannot be sent. Turn it on in Settings › Companion.`}
        </p>
      ) : null}

      {view.status?.sections.map((section) => (
        <MemoryCard key={section.title} title={section.title || "Status board"} aside={<span>{`${view.title} keeps it current`}</span>}>
          {section.items.map((item) => (
            <LineRow key={item.id} view={view} item={item} mode="change" canSend={sender.ready} onSend={send} />
          ))}
        </MemoryCard>
      ))}

      <MemoryCard title="Questions for you" aside={<span>{`${questions.length} items · answers go to ${view.title}'s conversation`}</span>}>
        {questions.length === 0 ? (
          <MemoryRow>
            <span className="text-muted-foreground">{`${view.title} has nothing to ask.`}</span>
          </MemoryRow>
        ) : null}
        {questions.map((item) => (
          <LineRow key={item.id} view={view} item={item} mode="answer" proposal={item.proposal} canSend={sender.ready} onSend={send} />
        ))}
      </MemoryCard>

      {us.length > 0 ? (
        <MemoryCard title="Between the two of you" aside={<span>us.md</span>}>
          {us.map((item) => (
            <LineRow key={item.id} view={view} item={item} mode="change" canSend={sender.ready} onSend={send} />
          ))}
        </MemoryCard>
      ) : null}

      <MemoryCard title="Records" aside={<span>By date</span>}>
        {view.records.length === 0 ? (
          <MemoryRow>
            <span className="text-muted-foreground">No records yet.</span>
          </MemoryRow>
        ) : null}
        {records.map((day) => (
          <MemoryRow
            key={day.date}
            actions={
              <>
                {day.daily ? (
                  <Button size="xs" variant="outline" onClick={() => onRead(day.daily!)}>
                    Read
                  </Button>
                ) : null}
                {day.diary ? (
                  <Button size="xs" variant="ghost" onClick={() => onRead(day.diary!)}>
                    Diary
                  </Button>
                ) : null}
              </>
            }
          >
            <div className="flex items-start gap-3">
              <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">{monthDay(day.date)}</span>
              <div className="min-w-0 flex-1">
                <span translate="no" className="line-clamp-2">
                  {day.headline || day.date}
                </span>
                <Muted>
                  <Dots parts={[day.daily ? "Daily record" : null, day.diary ? "Diary" : null]} />
                </Muted>
              </div>
            </div>
          </MemoryRow>
        ))}
        {view.records.length > RECORDS_SHOWN ? (
          <MemoryRow onClick={() => setShowAll(!showAll)}>
            <span className="text-xs text-muted-foreground">{showAll ? "Show fewer" : `All ${view.records.length} days`}</span>
          </MemoryRow>
        ) : null}
        {view.weekly.map((week) => (
          <MemoryRow key={week.week} actions={<Button size="xs" variant="outline" onClick={() => onRead(week.path)}>Read</Button>}>
            <div className="flex items-start gap-3">
              <span translate="no" className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
                {week.week.replace(/^\d{4}-/, "")}
              </span>
              <div className="min-w-0 flex-1">
                <span translate="no" className="line-clamp-2">
                  {week.headline}
                </span>
                <Muted>Weekly look back</Muted>
              </div>
            </div>
          </MemoryRow>
        ))}
      </MemoryCard>

      <MemoryCard title="People and companies" aside={<span>{view.entities.length}</span>}>
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {view.entities.length === 0 ? <span className="text-sm text-muted-foreground">None yet.</span> : null}
          {view.entities.map((entity) => (
            <Button key={entity.path} size="xs" variant="outline" title={entity.summary ?? undefined} onClick={() => onRead(entity.path)}>
              <span translate="no">{entity.name}</span>
            </Button>
          ))}
        </div>
      </MemoryCard>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="my-0.5 text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

/** One of the companion's lines with what the person can do about it: answer it, or ask for a change. */
function LineRow({
  view,
  item,
  mode,
  proposal = false,
  canSend,
  onSend,
}: {
  view: SegnoMemoryView;
  item: SegnoLine;
  mode: "answer" | "change";
  proposal?: boolean;
  canSend: boolean;
  onSend: (text: string, itemId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRow
      data-segno-line={item.id}
      actions={
        open ? null : (
          <Button
            size="xs"
            variant={mode === "answer" && !item.sent ? "default" : "ghost"}
            disabled={!canSend}
            className={mode === "change" ? "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" : undefined}
            onClick={() => setOpen(true)}
          >
            {mode === "answer" ? (proposal ? "Reply" : "Answer") : `Ask ${view.title}`}
          </Button>
        )
      }
    >
      <div className="flex items-start gap-2">
        {proposal ? <Tag tone="attention">Proposal</Tag> : null}
        <div className="min-w-0 flex-1">
          <span translate="no">{item.text}</span>
          <Muted>
            <Dots parts={[item.refs ? { keep: item.refs } : null, item.sent ? `Sent to ${view.title} ${ago(item.sent)}` : null]} />
          </Muted>
          {open ? (
            <AnswerBox
              companion={view.title}
              placeholder={mode === "answer" ? undefined : `What should ${view.title} change or know? It goes to ${view.title}'s conversation as your message.`}
              onCancel={() => setOpen(false)}
              onSend={async (text) => {
                await onSend(mode === "answer" ? answerText(item.text, text) : changeRequestText(item.text, text), item.id);
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      </div>
    </MemoryRow>
  );
}

/** One record of the companion's, as it is now, with how it changed. */
function RecordReader({ data, companionId, path, onClose }: { data: MemoryPageData; companionId: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<{ content: string; updatedAt: string | null } | null>(null);
  const [commits, setCommits] = useState<readonly SegnoCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ sha: string; text: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setCommits(null);
    setError(null);
    rubatoSegnoMemory.file(data.environmentId, path, companionId).then(
      (result) => {
        if (!cancelled) setFile({ content: result.content, updatedAt: result.updatedAt });
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    rubatoSegnoMemory.history(data.environmentId, path, companionId).then(
      (result) => {
        if (!cancelled) setCommits(result.commits);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data.environmentId, path, companionId]);
  const showDiff = async (sha: string) => {
    if (diff?.sha === sha) return setDiff(null);
    setDiff({ sha, text: null });
    try {
      const result = await rubatoSegnoMemory.diff(data.environmentId, path, sha, companionId);
      setDiff({ sha, text: result.diff });
    } catch (cause) {
      setDiff({ sha, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  const body = file?.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") ?? "";
  return (
    <MemoryCard
      title={
        <span className="flex items-center gap-2">
          <BookOpenIcon className="size-4 text-muted-foreground" />
          <span translate="no" className="font-mono text-xs">
            {path}
          </span>
        </span>
      }
      aside={
        <>
          {file?.updatedAt ? <span>{`Updated ${ago(file.updatedAt)}`}</span> : null}
          <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        </>
      }
    >
      <div className="max-h-[32rem] overflow-y-auto px-5 py-3 text-sm">
        {error ? <p className="text-destructive-foreground">{error}</p> : null}
        {!file && !error ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" /> Loading
          </p>
        ) : null}
        {file ? <ChatMarkdown text={body} cwd={undefined} /> : null}
      </div>
      {commits && commits.length > 0 ? (
        <div className="px-4 py-2">
          <p className="pb-1 text-xs text-muted-foreground">How it changed</p>
          <ul className="space-y-1">
            {commits.slice(0, 8).map((commit) => (
              <li key={commit.sha} className="text-xs">
                <button type="button" className="flex w-full items-baseline gap-3 text-left hover:text-foreground" aria-expanded={diff?.sha === commit.sha} onClick={() => void showDiff(commit.sha)}>
                  <span className="w-24 shrink-0 text-muted-foreground">{ago(commit.at)}</span>
                  <span translate="no" className="min-w-0 flex-1 truncate">
                    {commit.subject}
                  </span>
                </button>
                {diff?.sha === commit.sha ? (
                  <div className="py-2">{diff.text === null ? <Spinner className="size-3.5" /> : <DiffView diff={diff.text} />}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </MemoryCard>
  );
}
