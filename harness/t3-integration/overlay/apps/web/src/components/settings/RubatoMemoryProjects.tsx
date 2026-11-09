// Projects: each store is a list of questions (one file = one question's current answer), searchable
// and filterable by kind; opening one shows its answer and how it changed, commit by commit with diffs.
import { ChevronLeftIcon, MessageSquareIcon, PlayIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { rubatoMemory, type MemoryFileCommit, type MemoryFileEntry, type MemoryStoreSummary } from "../../state/rubatoMemory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { filterQuestions, listedStores, questionTitle, type QuestionFilter } from "./RubatoMemoryPage.logic";
import type { MemoryPageData } from "./RubatoMemoryPage";
import { ago, confirmAction, Dots, MemoryCard, MemoryRow, Muted, reportError, Tag, ViewHeading } from "./RubatoMemoryParts";
import { DiffView, FileViewer, tildePath, useAskInChat, whereLabel } from "./RubatoMemorySettings";

export type ProjectTarget = { readonly store: string; readonly file?: string };

const KIND_TAG = {
  decision: { tone: "decision", label: "Decision" },
  reference: { tone: "reference", label: "Fact" },
  skill: { tone: "reference", label: "Skill" },
  other: { tone: "quiet", label: "Note" },
} as const;

const WRITER_LABEL = { dream: "Dream", session: "Session", you: "You" } as const;

function homeOf(memoryRoot: string | null): string | null {
  return memoryRoot?.endsWith("/.rubato/memory") ? memoryRoot.slice(0, -"/.rubato/memory".length) : null;
}

export function ProjectsView({
  data,
  target,
  onTarget,
}: {
  data: MemoryPageData;
  target: ProjectTarget | null;
  onTarget: (target: ProjectTarget | null) => void;
}) {
  const home = homeOf(data.memoryRoot);
  if (data.storesError) return <p className="text-sm text-destructive-foreground">{data.storesError}</p>;
  if (data.stores === null)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </p>
    );
  const store = target ? data.stores.find((entry) => entry.store === target.store) : undefined;
  if (target && store) return <StoreQuestions key={store.store} data={data} store={store} home={home} file={target.file ?? null} onTarget={onTarget} />;
  const listed = listedStores(data.stores).toSorted((a, b) => String(b.lastChangeAt ?? "").localeCompare(String(a.lastChangeAt ?? "")));
  const empty = data.stores.length - listed.length;
  return (
    <>
      <ViewHeading title="Projects" sub="Each project keeps its own memory; only that project's lead reads it." />
      <MemoryCard title={`${listed.length} projects`} aside={empty > 0 ? <span>{`${empty} empty not shown`}</span> : undefined}>
        {listed.length === 0 ? (
          <MemoryRow>
            <span className="text-muted-foreground">A project's memory appears the first time an agent saves something in it.</span>
          </MemoryRow>
        ) : null}
        {listed.map((entry) => (
          <MemoryRow
            key={entry.store}
            onClick={() => onTarget({ store: entry.store })}
            actions={<span className="text-xs whitespace-nowrap text-muted-foreground">{entry.enabled ? "Dream on" : "Dream off"}</span>}
          >
            <div className="flex items-baseline gap-2">
              <b translate="no">{entry.store}</b>
              <span className="text-xs text-muted-foreground">{`${entry.files} questions`}</span>
            </div>
            <Muted>
              <Dots parts={[{ keep: whereLabel(entry, home) }, entry.lastChangeAt ? `Updated ${ago(entry.lastChangeAt)}` : null]} />
            </Muted>
          </MemoryRow>
        ))}
      </MemoryCard>
    </>
  );
}

function StoreQuestions({
  data,
  store,
  home,
  file,
  onTarget,
}: {
  data: MemoryPageData;
  store: MemoryStoreSummary;
  home: string | null;
  file: string | null;
  onTarget: (target: ProjectTarget | null) => void;
}) {
  const environmentId = data.environmentId;
  const [files, setFiles] = useState<MemoryFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QuestionFilter>("all");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState(0);
  const ask = useAskInChat(environmentId, store, home);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory.files(environmentId, store.store).then(
      (result) => {
        if (!cancelled) setFiles(result.files);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, store.store, signal]);

  const shown = useMemo(() => (files ? filterQuestions(files, filter, query) : []), [files, filter, query]);
  const counts = useMemo(
    () => ({
      decision: files?.filter((entry) => entry.kind === "decision").length ?? 0,
      reference: files?.filter((entry) => entry.kind === "reference").length ?? 0,
    }),
    [files],
  );
  // The question open on the right: the one asked for, else the newest.
  const open = file && files?.some((entry) => entry.path === file) ? file : (shown[0]?.path ?? null);
  const openEntry = files?.find((entry) => entry.path === open) ?? null;

  const setEnabled = async (enabled: boolean) => {
    const previous = data.stores;
    data.setStores(previous?.map((entry) => (entry.store === store.store ? { ...entry, enabled } : entry)) ?? null);
    try {
      await rubatoMemory.config(environmentId, { store: store.store, enabled });
    } catch (cause) {
      data.setStores(previous ? [...previous] : null);
      reportError("Could not save the setting", cause);
    }
  };
  const runNow = async () => {
    try {
      await rubatoMemory.dream(environmentId, store.store);
      toastManager.add({ type: "info", title: `Dream started for ${store.store}`, description: "This can take several minutes." });
      await data.reloadStores();
    } catch (cause) {
      reportError("Could not start the dream", cause);
    }
  };
  const removeStore = async () => {
    const ok = await confirmAction(
      `Delete the memory of "${store.store}"? It is archived to ~/.rubato/backups first. If an agent saves memory in this project again, a new empty one is created.`,
      true,
    );
    if (!ok) return;
    try {
      const result = await rubatoMemory.deleteStore(environmentId, store.store);
      toastManager.add({ type: "success", title: `Deleted ${store.store}`, description: `Archived to ${tildePath(result.archive, home)}` });
      onTarget(null);
      await data.reloadStores();
    } catch (cause) {
      reportError("Could not delete the memory", cause);
    }
  };

  return (
    <>
      <div>
        <Button size="xs" variant="ghost" onClick={() => onTarget(null)}>
          <ChevronLeftIcon className="size-3.5" />
          Projects
        </Button>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0 space-y-1">
          <h2 className="text-xl font-semibold">
            <span translate="no">{store.store}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Dots parts={[{ keep: whereLabel(store, home) }, `${store.files} questions`, store.enabled ? "Daily dream on" : "Daily dream off"]} />
          </p>
          <p className="text-xs text-muted-foreground">One file is one question's current answer. They show as questions here, not folders.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => void ask()}>
            <MessageSquareIcon className="size-3" />
            Ask in chat
          </Button>
          <Button size="xs" variant="outline" disabled={store.running !== null} onClick={() => void runNow()}>
            {store.running ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
            {store.running ? "Dreaming" : "Dream now"}
          </Button>
          <span className="flex items-center gap-1.5 ps-1 text-xs text-muted-foreground">
            Daily dream
            <Switch aria-label={`Daily dream for ${store.store}`} checked={store.enabled} onCheckedChange={(enabled) => void setEnabled(enabled)} />
          </span>
          <Button size="icon-xs" variant="ghost" aria-label={`Delete the memory of ${store.store}`} disabled={store.running !== null} onClick={() => void removeStore()}>
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="ps-9" placeholder="Find in this project" value={query} aria-label="Find in this project" onChange={(event) => setQuery(event.currentTarget.value)} />
        </div>
        {(
          [
            ["all", `All ${files?.length ?? ""}`.trim()],
            ["decision", `Decisions ${counts.decision}`],
            ["reference", `Facts ${counts.reference}`],
            ["recent", "Changed this week"],
          ] as const
        ).map(([value, label]) => (
          <Button key={value} size="xs" variant={filter === value ? "secondary" : "outline"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}
          </Button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      {files === null && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" /> Loading
        </p>
      ) : null}
      {files ? (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <MemoryCard className="max-h-[calc(100dvh-16rem)] overflow-y-auto">
            {shown.length === 0 ? (
              <MemoryRow>
                <span className="text-muted-foreground">No question matches.</span>
              </MemoryRow>
            ) : null}
            {shown.map((entry) => {
              const kind = KIND_TAG[entry.kind ?? "other"];
              return (
                <MemoryRow key={entry.path} data-file={entry.path} selected={entry.path === open} onClick={() => onTarget({ store: store.store, file: entry.path })}>
                  <div className="flex items-start gap-2">
                    <Tag tone={kind.tone}>{kind.label}</Tag>
                    <span translate="no" className="line-clamp-2 min-w-0">
                      {questionTitle(entry)}
                    </span>
                  </div>
                  <Muted>
                    <Dots parts={[entry.changedAt ? ago(entry.changedAt) : null, entry.writer ? WRITER_LABEL[entry.writer] : null]} />
                  </Muted>
                </MemoryRow>
              );
            })}
          </MemoryCard>
          {openEntry ? (
            <QuestionDetail
              key={`${openEntry.path}:${signal}`}
              data={data}
              store={store}
              entry={openEntry}
              onAsk={() => void ask({ file: openEntry.path })}
              onChanged={() => {
                setSignal((value) => value + 1);
                void data.reloadStores();
              }}
              onDeleted={() => {
                onTarget({ store: store.store });
                setSignal((value) => value + 1);
                void data.reloadStores();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function QuestionDetail({
  data,
  store,
  entry,
  onAsk,
  onChanged,
  onDeleted,
}: {
  data: MemoryPageData;
  store: MemoryStoreSummary;
  entry: MemoryFileEntry;
  onAsk: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const kind = KIND_TAG[entry.kind ?? "other"];
  const remove = async () => {
    const ok = await confirmAction(`Delete ${entry.path} from ${store.store}? The deletion is committed, so the history keeps the old version.`, true);
    if (!ok) return;
    try {
      await rubatoMemory.deleteFile(data.environmentId, store.store, entry.path);
      toastManager.add({ type: "success", title: `Deleted ${entry.path}` });
      onDeleted();
    } catch (cause) {
      reportError(`Could not delete ${entry.path}`, cause);
    }
  };
  return (
    <div className="min-w-0 space-y-3">
      <MemoryCard>
        <div className="space-y-1.5 px-5 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Tag tone={kind.tone}>{kind.label}</Tag>
            <Button size="xs" variant="ghost" onClick={() => void remove()}>
              <Trash2Icon className="size-3" />
              Delete
            </Button>
          </div>
          <h3 translate="no" className="text-base font-semibold">
            {questionTitle(entry)}
          </h3>
          {entry.description && entry.title ? (
            <p translate="no" className="text-xs text-muted-foreground">
              {entry.description}
            </p>
          ) : null}
          <p translate="no" className="font-mono text-[11px] text-muted-foreground/80">
            {entry.path}
          </p>
        </div>
        <div className="pt-1">
          <FileViewer environmentId={data.environmentId} store={store.store} path={entry.path} onAsk={onAsk} onSaved={onChanged} />
        </div>
      </MemoryCard>
      <FileHistory data={data} store={store.store} path={entry.path} />
    </div>
  );
}

function FileHistory({ data, store, path }: { data: MemoryPageData; store: string; path: string }) {
  const [commits, setCommits] = useState<MemoryFileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rubatoMemory.fileHistory(data.environmentId, store, path).then(
      (result) => {
        if (!cancelled) setCommits(result.commits);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [data.environmentId, store, path]);
  return (
    <MemoryCard title="How this answer changed" aside={<span>{commits ? `${commits.length} changes · git history` : "git history"}</span>}>
      {error ? (
        <MemoryRow>
          <span className="text-destructive-foreground">{error}</span>
        </MemoryRow>
      ) : null}
      {commits === null && !error ? (
        <MemoryRow>
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" /> Loading
          </span>
        </MemoryRow>
      ) : null}
      {commits?.map((commit) => (
        <div key={commit.sha}>
          <MemoryRow
            data-commit={commit.sha}
            actions={
              <Button size="xs" variant={open === commit.sha ? "secondary" : "outline"} aria-expanded={open === commit.sha} onClick={() => setOpen(open === commit.sha ? null : commit.sha)}>
                {open === commit.sha ? "Hide changes" : "Show changes"}
              </Button>
            }
          >
            <div className="flex items-start gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{ago(commit.at)}</span>
              <div className="min-w-0 flex-1">
                {commit.adopted ? (
                  <span>Took in an edit a session made outside the memory tools</span>
                ) : commit.text ? (
                  <span translate="no">{commit.text}</span>
                ) : (
                  <span className="italic">Saved without a reason</span>
                )}
                <Muted>
                  <Dots
                    parts={[
                      WRITER_LABEL[commit.writer],
                      commit.change === "added" ? "Created" : commit.change === "deleted" ? "Deleted" : commit.change === "renamed" ? "Moved" : null,
                      commit.from ? { keep: commit.from } : null,
                    ]}
                  />
                </Muted>
              </div>
            </div>
          </MemoryRow>
          {open === commit.sha ? (
            <div className={cn("px-4 pb-3")}>
              <CommitDiff data={data} store={store} path={commit.path} sha={commit.sha} />
            </div>
          ) : null}
        </div>
      ))}
    </MemoryCard>
  );
}

function CommitDiff({ data, store, path, sha }: { data: MemoryPageData; store: string; path: string; sha: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rubatoMemory.fileDiff(data.environmentId, store, path, sha).then(
      (result) => {
        if (!cancelled) setDiff(result.diff);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [data.environmentId, store, path, sha]);
  if (error) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (diff === null)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </p>
    );
  return <DiffView diff={diff} />;
}
