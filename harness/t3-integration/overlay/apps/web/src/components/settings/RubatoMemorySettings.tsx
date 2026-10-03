import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import {
  rubatoMemory,
  type DreamChange,
  type DreamModel,
  type DreamReasoning,
  type DreamRunDetail,
  type DreamRunSummary,
  type DreamSuggestion,
  type MemoryActivity,
  type MemoryFileEntry,
  type MemorySearchHit,
  type MemoryStatus,
  type MemoryStoreStatus,
  type MemoryStoreSummary,
} from "../../state/rubatoMemory";
import ChatMarkdown from "../ChatMarkdown";
import { iconForProviderModel } from "../chat/providerIconUtils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  addedContent,
  chatPrompt,
  fallbackNote,
  lastDreamLine,
  overviewStatus,
  projectForStore,
  runLabel,
  splitQuiet,
  type BadgeVariant,
} from "./RubatoMemorySettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string | undefined | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

async function confirm(message: string, destructive = false): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: destructive ? "destructive" : "default" });
  return answer ? await answer : window.confirm(message);
}

/** The primary environment's id once its HTTP connection is ready; null until then. */
export function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

/** A store from its directory, plus what the dream CLI knows once that answers. */
type StoreView = MemoryStoreSummary & {
  readonly lastDreamAt?: string;
  readonly newSessions?: number;
  readonly due?: boolean;
  readonly lastGuiRun?: MemoryStoreStatus["lastGuiRun"];
};

function mergeStores(summaries: readonly MemoryStoreSummary[], status: MemoryStatus | null): StoreView[] {
  const byName = new Map(status?.stores.map((entry) => [entry.store, entry]) ?? []);
  const merged = summaries.map((summary): StoreView => {
    const cli = byName.get(summary.store);
    if (!cli) return summary;
    return {
      ...summary,
      roots: summary.roots ?? (cli.roots ? [...cli.roots] : null),
      home: summary.home ?? cli.home ?? null,
      enabled: cli.enabled,
      running: summary.running ?? cli.running,
      newSessions: cli.newSessions,
      due: cli.due,
      lastGuiRun: cli.lastGuiRun,
      ...(cli.lastDreamAt ? { lastDreamAt: cli.lastDreamAt } : {}),
    };
  });
  const activity = (store: StoreView) =>
    [store.lastChangeAt, store.lastDreamAt].filter(Boolean).toSorted().at(-1) ?? "";
  return merged.toSorted(
    (a, b) => activity(b).localeCompare(activity(a)) || a.store.localeCompare(b.store),
  );
}

function tildePath(value: string, home: string | null): string {
  return home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
}

function whereLabel(store: StoreView, home: string | null): string {
  if (store.home) return "Used in your home folder";
  if (store.roots && store.roots.length > 0)
    return `Used in ${store.roots.map((root) => tildePath(root, home)).join(", ")}`;
  return "No project folder recorded yet";
}

type Tab = "overview" | "you" | "settings";
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "you", label: "About you" },
  { value: "settings", label: "Settings" },
];

export function RubatoMemorySettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [summaries, setSummaries] = useState<MemoryStoreSummary[] | null>(null);
  const [memoryRoot, setMemoryRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A project open on its own page, with the file or dream run the user came for already unfolded.
  const [opened, setOpened] = useState<OpenTarget | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [historySignal, setHistorySignal] = useState(0);
  const [suggestions, setSuggestions] = useState<DreamSuggestion[] | null>(null);
  const loadingRef = useRef(false);

  const loadSuggestions = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setSuggestions((await rubatoMemory.suggestions(environmentId)).suggestions);
    } catch {
      // The list is optional; the About you tab says nothing rather than fail the page.
      setSuggestions([]);
    }
  }, [environmentId]);

  const loadStores = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoMemory.stores(environmentId);
      setSummaries(next.stores);
      setMemoryRoot(next.memoryRoot);
      setStoresError(null);
    } catch (error) {
      setStoresError(error instanceof Error ? error.message : String(error));
    }
  }, [environmentId]);

  const refresh = useCallback(async () => {
    if (environmentId === null || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await Promise.all([
        loadStores(),
        loadSuggestions(),
        rubatoMemory.status(environmentId).then(
          (next) => {
            setStatus(next);
            setStatusError(null);
          },
          (error: unknown) => setStatusError(error instanceof Error ? error.message : String(error)),
        ),
      ]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [environmentId, loadStores, loadSuggestions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stores = useMemo(() => (summaries ? mergeStores(summaries, status) : null), [summaries, status]);
  const home = memoryRoot?.endsWith("/.rubato/memory") ? memoryRoot.slice(0, -"/.rubato/memory".length) : null;

  // A dream runs for minutes. While one is going, look again every 15 seconds.
  const anyRunning = stores?.some((store) => store.running !== null) ?? false;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!anyRunning) {
      if (wasRunning.current) setHistorySignal((value) => value + 1);
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [anyRunning, refresh]);

  // After a file edit the store list (file count, last change) and any open history are stale.
  const changed = useCallback(() => {
    setHistorySignal((value) => value + 1);
    void loadStores();
  }, [loadStores]);

  const saveConfig = async (change: Parameters<typeof rubatoMemory.config>[1], undo: () => void) => {
    try {
      await rubatoMemory.config(environmentId, change);
    } catch (error) {
      undo();
      reportError("Could not save the setting", error);
    }
  };

  const setModels = (models: readonly DreamModel[]) => {
    const previous = status;
    if (previous) setStatus({ ...previous, models });
    void saveConfig(
      { models: models.map((entry) => (entry.reasoning ? { model: entry.model, reasoning: entry.reasoning } : { model: entry.model })) },
      () => setStatus(previous),
    );
  };
  const setEnabled = (store: string, enabled: boolean) => {
    const previousSummaries = summaries;
    const previousStatus = status;
    setSummaries((current) =>
      current?.map((entry) => (entry.store === store ? { ...entry, enabled } : entry)) ?? current,
    );
    setStatus((current) =>
      current
        ? { ...current, stores: current.stores.map((entry) => (entry.store === store ? { ...entry, enabled } : entry)) }
        : current,
    );
    void saveConfig({ store, enabled }, () => {
      setSummaries(previousSummaries);
      setStatus(previousStatus);
    });
  };

  const runNow = async (store: string) => {
    try {
      await rubatoMemory.dream(environmentId, store);
      toastManager.add({
        type: "info",
        title: `Dream started for ${store}`,
        description: "This can take several minutes. Its changes go into memory and show under Dream runs.",
      });
      await refresh();
    } catch (error) {
      reportError("Could not start the dream", error);
    }
  };

  const selected = opened ? stores?.find((entry) => entry.store === opened.store) : undefined;
  if (opened && stores && !selected) {
    // Deleted, or gone from disk since the list was read.
    setOpened(null);
  }

  if (selected) {
    return (
      <SettingsPageContainer>
        <StoreDetail
          key={`${opened?.store}:${opened?.file ?? ""}:${opened?.runId ?? ""}`}
          environmentId={environmentId}
          store={selected}
          home={home}
          historySignal={historySignal}
          initialFile={opened?.file ?? null}
          initialRun={opened?.runId ?? null}
          onBack={() => setOpened(null)}
          onToggle={(enabled) => setEnabled(selected.store, enabled)}
          onRun={() => void runNow(selected.store)}
          onChanged={changed}
          onDeleted={() => {
            setOpened(null);
            void refresh();
          }}
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <div className="px-3 sm:px-4">
        <ToggleGroup
          aria-label="Memory settings"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = TABS.find((entry) => entry.value === next[0])?.value;
            if (value) setTab(value);
          }}
        >
          {TABS.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.value === "you" && suggestions && suggestions.length > 0
                ? `${entry.label} · ${suggestions.length}`
                : entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      {tab === "overview" ? (
        storesError ? (
          <SettingsSection id="memory-overview" title="Memory">
            <SettingsRow title="Could not load memory" description={storesError} />
          </SettingsSection>
        ) : stores === null ? (
          <SettingsSection id="memory-overview" title="Memory">
            <SettingsRow title="Loading memory" control={<Spinner className="size-4" />} />
          </SettingsSection>
        ) : (
          <Overview
            environmentId={environmentId}
            stores={stores}
            home={home}
            loading={loading}
            onRefresh={() => void refresh()}
            onOpen={setOpened}
          />
        )
      ) : null}

      {tab === "you" ? (
        <>
          {suggestions && suggestions.length > 0 ? (
            <SuggestionsSection
              environmentId={environmentId}
              suggestions={suggestions}
              onChanged={() => void loadSuggestions()}
            />
          ) : null}
          <SelfFilesSection environmentId={environmentId} />
        </>
      ) : null}

      {tab === "settings" ? (
        <>
          <SettingsSection id="memory-dream" title="Dream">
            {statusError ? (
              <SettingsRow title="Could not load dream settings" description={statusError} />
            ) : status === null ? (
              <SettingsRow
                title="Loading dream settings"
                description="Scanning sessions can take a few seconds."
                control={<Spinner className="size-4" />}
              />
            ) : (
              <DreamModelsEditor models={status.models} onChange={setModels} />
            )}
          </SettingsSection>
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

function StoreFacts({ store }: { store: StoreView }) {
  // A run started here that died before writing a run record (no runId) shows only here.
  const last = store.lastGuiRun;
  const guiFailed =
    !store.running &&
    last?.status === "failed" &&
    !last.runId &&
    (last.startedAt ?? "") > (store.lastRun?.startedAt ?? "");
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>
        {[count(store.files, "file"), store.lastChangeAt ? `updated ${ago(store.lastChangeAt)}` : "no changes yet"].join(
          " · ",
        )}
      </span>
      {store.running ? (
        <Badge variant="info">
          <Spinner className="size-3" />
          Dreaming{store.running.startedAt ? ` (started ${ago(store.running.startedAt)})` : ""}
        </Badge>
      ) : guiFailed ? (
        <span className="text-destructive-foreground" title={last?.reason}>
          Last dream failed: {(last?.reason ?? "").split("\n")[0]}
        </span>
      ) : (
        <DreamLine store={store} />
      )}
    </span>
  );
}

function DreamLine({ store }: { store: StoreView }) {
  const line = lastDreamLine(store.enabled, store.lastRun, ago);
  return <span className={cn(line.tone === "error" && "text-destructive-foreground")}>{line.text}</span>;
}

function StoreRow({ store, home, onOpen }: { store: StoreView; home: string | null; onOpen: () => void }) {
  return (
    <SettingsRow
      className="cursor-pointer hover:bg-accent/30"
      onClick={onOpen}
      title={store.store}
      description={
        <span className="block truncate" title={whereLabel(store, home)}>
          {whereLabel(store, home)}
        </span>
      }
      status={<StoreFacts store={store} />}
      control={
        <Button size="icon-xs" variant="ghost" aria-label={`Open ${store.store}`} onClick={onOpen}>
          <ChevronRightIcon className="size-4" />
        </Button>
      }
    />
  );
}

/** What opening a project from the overview lands on. */
type OpenTarget = { readonly store: string; readonly file?: string; readonly runId?: string };

/** The landing page: is memory working, what changed lately, find anything, then the projects. */
function Overview({
  environmentId,
  stores,
  home,
  loading,
  onRefresh,
  onOpen,
}: {
  environmentId: EnvironmentId;
  stores: readonly StoreView[];
  home: string | null;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (target: OpenTarget) => void;
}) {
  const status = overviewStatus(stores);
  const { active, quiet } = splitQuiet(stores, Date.now());
  const [showQuiet, setShowQuiet] = useState(false);
  return (
    <>
      <SettingsSection id="memory-status" title="Status" hideTitle>
        <SettingsRow
          title={
            stores.length === 0
              ? "Memory is on. Nothing is saved yet."
              : `Memory is on. Agents keep what they learn in ${count(status.projects, "project")}, ${count(status.notes, "note")} in all.`
          }
          description={
            stores.length === 0
              ? "A project's memory appears the first time an agent saves something in it. Once a day a dream tidies it on its own."
              : [
                  `Daily dream on for ${status.dreaming} of ${status.projects}`,
                  status.newest
                    ? `last ran ${ago(status.newest.run.finishedAt ?? status.newest.run.startedAt)} in ${status.newest.store}`
                    : "no dream has run yet",
                ].join(" · ")
          }
        />
        {status.attention.map((item) => (
          <SettingsRow
            key={`${item.store}:${item.runId}`}
            className="bg-warning/8"
            title={<span className="text-warning-foreground">⚠ {item.title}</span>}
            description={item.detail ?? undefined}
            control={
              <Button size="xs" variant="outline" onClick={() => onOpen({ store: item.store, runId: item.runId })}>
                See run
              </Button>
            }
          />
        ))}
      </SettingsSection>

      <MemorySearch environmentId={environmentId} onOpen={onOpen} />

      {stores.length > 0 ? <RecentChanges environmentId={environmentId} onOpen={onOpen} /> : null}

      {stores.length > 0 ? (
        <SettingsSection
          id="memory-stores"
          title="Projects"
          headerAction={
            <Button size="xs" variant="ghost" disabled={loading} onClick={onRefresh}>
              {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
              Refresh
            </Button>
          }
        >
          {active.map((store) => (
            <StoreRow key={store.store} store={store} home={home} onOpen={() => onOpen({ store: store.store })} />
          ))}
          {showQuiet
            ? quiet.map((store) => (
                <StoreRow key={store.store} store={store} home={home} onOpen={() => onOpen({ store: store.store })} />
              ))
            : null}
          {quiet.length > 0 ? (
            <SettingsRow
              className="cursor-pointer hover:bg-accent/30"
              onClick={() => setShowQuiet(!showQuiet)}
              title={
                <span className="text-sm font-normal text-muted-foreground">
                  {showQuiet ? "Hide quiet projects" : `${count(quiet.length, "quiet project")} (no change in 3 weeks) · show`}
                </span>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

/** One search box over every project's memory; a result opens its file. */
function MemorySearch({ environmentId, onOpen }: { environmentId: EnvironmentId; onOpen: (target: OpenTarget) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; hits: MemorySearchHit[] } | null>(null);
  const [searching, setSearching] = useState(false);

  const submit = async () => {
    const text = query.trim();
    if (text === "") return;
    setSearching(true);
    try {
      const found = await rubatoMemory.search(environmentId, text);
      setResults({ query: text, hits: found.results });
    } catch (cause) {
      reportError("Could not search memory", cause);
    } finally {
      setSearching(false);
    }
  };

  return (
    <SettingsSection id="memory-search" title="Search" hideTitle>
      <form
        className="relative px-3 py-2.5 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SearchIcon className="pointer-events-none absolute start-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:start-6" />
        <Input
          className="ps-8"
          placeholder="Search all memory: a decision, an error, a file name…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            if (event.currentTarget.value === "") setResults(null);
          }}
          aria-label="Search all memory"
        />
        {searching ? <Spinner className="absolute end-6 top-1/2 size-4 -translate-y-1/2" /> : null}
      </form>
      {results && results.hits.length === 0 ? (
        <SettingsRow title={`Nothing in memory matches "${results.query}"`} />
      ) : null}
      {results?.hits.map((hit) => (
        <SettingsRow
          key={`${hit.store}/${hit.path}`}
          className="cursor-pointer hover:bg-accent/30"
          onClick={() => onOpen({ store: hit.store, file: hit.path })}
          title={
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono text-xs">{hit.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{hit.store}</span>
            </span>
          }
          description={hit.description ?? hit.preview}
        />
      ))}
    </SettingsSection>
  );
}

const ACTIVITY_PAGE = 20;
const ACTIVITY_KIND: Record<MemoryActivity["kind"], { label: string; variant: BadgeVariant }> = {
  dream: { label: "Dream", variant: "info" },
  session: { label: "Session", variant: "success" },
  you: { label: "You", variant: "secondary" },
};
const CHANGE_MARK: Record<DreamChange["change"], string> = { added: "+", modified: "~", deleted: "−", renamed: "→" };
const FILES_SHOWN = 3;

/** Every project's recent commits in one list, newest first: who changed what, and why. */
function RecentChanges({ environmentId, onOpen }: { environmentId: EnvironmentId; onOpen: (target: OpenTarget) => void }) {
  const [limit, setLimit] = useState(ACTIVITY_PAGE);
  const [items, setItems] = useState<MemoryActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .activity(environmentId, limit)
      .then((result) => {
        if (!cancelled) setItems(result.items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, limit]);

  const open = (item: MemoryActivity) => {
    if (item.kind === "dream" && item.runId) return onOpen({ store: item.store, runId: item.runId });
    const file = item.files.find((entry) => entry.change !== "deleted");
    return onOpen(item.files.length === 1 && file ? { store: item.store, file: file.path } : { store: item.store });
  };

  return (
    <SettingsSection id="memory-activity" title="Recent changes">
      {error ? <SettingsRow title="Could not load recent changes" description={error} /> : null}
      {items === null && !error ? <SettingsRow title="Loading" control={<Spinner className="size-4" />} /> : null}
      {items?.map((item) => {
        const kind = ACTIVITY_KIND[item.kind];
        const more = item.files.length - FILES_SHOWN;
        return (
          <SettingsRow
            key={`${item.store}:${item.sha}`}
            title={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Badge variant={kind.variant}>{kind.label}</Badge>
                <span className="text-xs font-normal text-muted-foreground">
                  {item.store} · {ago(item.at)}
                </span>
              </span>
            }
            description={
              <span className="block space-y-0.5">
                <span className={cn("block", item.text === null && "italic")}>
                  {item.text ?? "Saved by a session without a reason"}
                </span>
                <span className="block truncate font-mono text-xs">
                  {item.files
                    .slice(0, FILES_SHOWN)
                    .map((file) => `${CHANGE_MARK[file.change]} ${file.path}`)
                    .join("   ")}
                  {more > 0 ? `   +${more} more` : ""}
                </span>
              </span>
            }
            control={
              <Button size="xs" variant="outline" onClick={() => open(item)}>
                Open
              </Button>
            }
          />
        );
      })}
      {items && items.length >= limit ? (
        <SettingsRow
          className="cursor-pointer hover:bg-accent/30"
          onClick={() => setLimit(limit + ACTIVITY_PAGE)}
          title={<span className="text-sm font-normal text-muted-foreground">Show older changes</span>}
        />
      ) : null}
    </SettingsSection>
  );
}

/** Scrolls the element carrying `attribute="value"` into view once it exists (null: nothing to do). */
function useScrollIntoView(value: string | null, attribute: string) {
  useEffect(() => {
    if (value === null) return;
    document.querySelector(`[${attribute}="${CSS.escape(value)}"]`)?.scrollIntoView({ block: "center" });
  }, [value, attribute]);
}

type AskAbout = Parameters<typeof chatPrompt>[1];

/** Opens a new thread in the memory's project with where it is in the composer; the user picks a model and asks. */
function useAskInChat(environmentId: EnvironmentId, store: StoreView, home: string | null) {
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  return async (about: AskAbout = {}) => {
    const candidates = projects.filter((project) => project.environmentId === environmentId);
    const project = projectForStore(candidates, store.home && home ? [home] : store.roots);
    if (!project) {
      toastManager.add({
        type: "error",
        title: "No project for this memory",
        description: `Add ${store.roots?.[0] ? tildePath(store.roots[0], home) : "its folder"} as a project, then ask again.`,
      });
      return;
    }
    const opened = await newThread(scopeProjectRef(project.environmentId, project.id)).catch(() => null);
    if (!opened) {
      toastManager.add({ type: "error", title: "Could not open a thread", description: "Open one from the project, then ask again." });
      return;
    }
    useComposerDraftStore.getState().setPrompt(opened.draftId, chatPrompt(store, about));
  };
}

function StoreDetail({
  environmentId,
  store,
  home,
  historySignal,
  initialFile,
  initialRun,
  onBack,
  onToggle,
  onRun,
  onChanged,
  onDeleted,
}: {
  environmentId: EnvironmentId;
  store: StoreView;
  home: string | null;
  historySignal: number;
  initialFile: string | null;
  initialRun: string | null;
  onBack: () => void;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const ask = useAskInChat(environmentId, store, home);
  const deleteStore = async () => {
    const ok = await confirm(
      `Delete the memory of "${store.store}"? It is archived to ~/.rubato/backups first. If an agent saves memory in this project again, a new empty one is created.`,
      true,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const result = await rubatoMemory.deleteStore(environmentId, store.store);
      toastManager.add({
        type: "success",
        title: `Deleted ${store.store}`,
        description: `Archived to ${tildePath(result.archive, home)}`,
      });
      onDeleted();
    } catch (error) {
      reportError("Could not delete the memory", error);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div>
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          Memory
        </Button>
      </div>
      <SettingsSection id="memory-store" title={store.store}>
        <SettingsRow
          title={whereLabel(store, home)}
          description={<StoreFacts store={store} />}
          control={
            <Button size="xs" variant="outline" onClick={() => void ask()}>
              <MessageSquareIcon className="size-3" />
              Ask in chat
            </Button>
          }
        />
        <SettingsRow
          title="Daily dream"
          description="Once a day, when there are new sessions, the dream reads them and updates this memory. Its changes go in right away; fix anything by editing the files below."
          control={
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={store.running !== null}
                onClick={onRun}
                aria-label={`Run a dream for ${store.store} now`}
              >
                <PlayIcon className="size-3" />
                Dream now
              </Button>
              <Switch
                aria-label={`Daily dream for ${store.store}`}
                checked={store.enabled}
                onCheckedChange={(enabled) => onToggle(enabled)}
              />
            </>
          }
        />
      </SettingsSection>

      <StoreFiles
        environmentId={environmentId}
        store={store.store}
        initialOpen={initialFile}
        onChanged={onChanged}
        onAsk={(file) => void ask({ file })}
      />

      <DreamRuns
        key={`${store.store}:${historySignal}`}
        environmentId={environmentId}
        store={store}
        initialOpen={initialRun}
        onAsk={(run) => void ask({ run })}
      />

      <SettingsSection id="memory-store-delete" title="Delete">
        <SettingsRow
          title="Delete this memory"
          description="Archives it to ~/.rubato/backups, then removes it."
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={deleting || store.running !== null}
              onClick={() => void deleteStore()}
            >
              {deleting ? <Spinner className="size-3" /> : <Trash2Icon className="size-3" />}
              Delete…
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}

const CHANGE_LABEL: Record<DreamChange["change"], { label: string; variant: BadgeVariant }> = {
  added: { label: "New", variant: "success" },
  modified: { label: "Edited", variant: "info" },
  deleted: { label: "Deleted", variant: "error" },
  renamed: { label: "Moved", variant: "secondary" },
};

const NOTE_LABEL: Record<DreamChange["notes"][number]["kind"], string> = {
  why: "Why",
  code: "Fixed to match the code",
  conflict: "Resolved",
};

const CARDS_SHOWN = 8;

/** One dream run: what it says it did, one card per file it changed, and its report folded below. */
function RunView({
  environmentId,
  store,
  runId,
  onAsk,
}: {
  environmentId: EnvironmentId;
  store: StoreView;
  runId: string;
  onAsk: (run: DreamRunDetail) => void;
}) {
  const [detail, setDetail] = useState<DreamRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .run(environmentId, store.store, runId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store.store, runId]);

  if (error) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (!detail)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </div>
    );

  const cards = showAll ? detail.changes : detail.changes.slice(0, CARDS_SHOWN);
  return (
    <div className="space-y-3">
      {detail.summary ? <p className="text-sm text-foreground/90">{detail.summary}</p> : null}

      {detail.changes.length === 0 ? (
        detail.diffNote && detail.diffNote !== "truncated" ? (
          <p className="text-sm text-muted-foreground">Could not read the changes: {detail.diffNote}</p>
        ) : null
      ) : (
        <ul className="space-y-2">
          {cards.map((change) => (
            <ChangeCard key={change.path} change={change} />
          ))}
        </ul>
      )}
      {detail.changes.length > CARDS_SHOWN ? (
        <Button size="xs" variant="ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${detail.changes.length} files`}
        </Button>
      ) : null}
      {detail.diffNote === "truncated" ? (
        <p className="text-xs text-muted-foreground">The changes are too large to show in full.</p>
      ) : null}

      {detail.attempts.some((attempt) => !attempt.ok) ? (
        <div className="space-y-1 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <p className="text-muted-foreground">Models tried, in order</p>
          <ol className="space-y-0.5">
            {detail.attempts.map((attempt, index) => (
              // The same model can sit on the ladder once; position is still the clearer key.
              <li key={index} className="flex gap-2">
                <span className={cn("shrink-0 font-mono", attempt.ok ? "text-success-foreground" : "text-destructive-foreground")}>
                  {attempt.ok ? "✓" : "✗"} {attempt.model}
                </span>
                {attempt.error ? <span className="min-w-0 break-words text-muted-foreground">{attempt.error}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {detail.report ? (
        <div className="text-xs text-muted-foreground">
          <Fold label="The dream's report">
            <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-border/60 px-3 py-2 text-sm text-foreground">
              <ChatMarkdown text={detail.report} cwd={undefined} />
            </div>
          </Fold>
        </div>
      ) : null}
      <Button size="xs" variant="ghost" onClick={() => onAsk(detail)}>
        <MessageSquareIcon className="size-3.5" />
        Ask in chat about this run
      </Button>
    </div>
  );
}

function ChangeCard({ change }: { change: DreamChange }) {
  const [open, setOpen] = useState(false);
  const kind = CHANGE_LABEL[change.change];
  const preview = change.change === "added" && change.path.endsWith(".md") ? addedContent(change.diff) : null;
  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <div className="flex items-start gap-2 px-3 pt-2 pb-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
            <Badge variant={kind.variant}>{kind.label}</Badge>
            <span className="truncate font-mono text-xs" title={change.path}>
              {change.path}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {change.added > 0 ? `+${change.added}` : ""}
              {change.added > 0 && change.removed > 0 ? " " : ""}
              {change.removed > 0 ? `−${change.removed}` : ""}
            </span>
          </span>
          {change.description ? <span className="mt-1 block text-sm">{change.description}</span> : null}
          {change.from ? <span className="block text-xs text-muted-foreground">Moved from {change.from}</span> : null}
        </button>
      </div>
      {change.notes.length > 0 ? (
        <ul className="space-y-0.5 px-3 pb-2 ps-8 text-xs text-muted-foreground">
          {change.notes.map((note, index) => (
            // A report can say the same thing twice; position is the identity.
            <li key={index}>
              <span className="font-medium text-foreground/80">{NOTE_LABEL[note.kind]}:</span> {note.text}
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">
          {preview ? (
            <div className="max-h-[28rem] overflow-y-auto text-sm">
              <ChatMarkdown text={preview} cwd={undefined} />
            </div>
          ) : (
            <DiffView diff={change.diff} />
          )}
        </div>
      ) : null}
    </li>
  );
}


function DreamRuns({
  environmentId,
  store,
  initialOpen,
  onAsk,
}: {
  environmentId: EnvironmentId;
  store: StoreView;
  initialOpen: string | null;
  onAsk: (run: DreamRunDetail) => void;
}) {
  const [runs, setRuns] = useState<DreamRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(initialOpen);
  useScrollIntoView(runs !== null ? initialOpen : null, "data-run");

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .runs(environmentId, store.store)
      .then((result) => {
        if (cancelled) return;
        setRuns(result.runs);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store.store]);

  return (
    <SettingsSection id="memory-history" title="Dream runs">
      {error ? <SettingsRow title="Could not load the runs" description={error} /> : null}
      {runs === null && !error ? (
        <SettingsRow title="Loading runs" control={<Spinner className="size-4" />} />
      ) : null}
      {runs?.length === 0 ? <SettingsRow title="No dream has run here yet" /> : null}
      {runs?.map((run) => {
        const label = runLabel(run);
        const expanded = open === run.runId;
        return (
          <SettingsRow
            key={run.runId}
            title={
              <button
                type="button"
                className="flex items-center gap-1.5 text-left"
                aria-expanded={expanded}
                data-run={run.runId}
                onClick={() => setOpen(expanded ? null : run.runId)}
              >
                <ChevronRightIcon
                  className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")}
                />
                {stamp(run.startedAt) || run.runId}
                <Badge variant={label.variant}>{label.label}</Badge>
              </button>
            }
            description={[
              `Read ${count(run.sessions, "session")}`,
              run.model ?? null,
              fallbackNote(run.attempts ?? []),
              run.status === "failed" || run.status === "busy" ? (run.reason ?? null) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {expanded ? (
              <div className="pt-1 pb-3">
                <RunView environmentId={environmentId} store={store} runId={run.runId} onAsk={onAsk} />
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md bg-muted/30">
      <pre className="min-w-max px-3 py-2 font-mono text-xs leading-5">
        {diff.split("\n").map((line, index) => (
          <div
            // Lines of a diff have no identity beyond their position.
            key={index}
            className={cn(
              line.startsWith("diff --git") && "font-semibold text-foreground",
              line.startsWith("@@") && "text-info-foreground",
              line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success-foreground",
              line.startsWith("-") && !line.startsWith("---") && "bg-destructive/10 text-destructive-foreground",
              (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) &&
                "text-muted-foreground",
            )}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

const FOLDER_ORDER = ["decisions", "reference", "skills"];

function groupFiles(files: readonly MemoryFileEntry[]) {
  const groups = new Map<string, MemoryFileEntry[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const folder = slash === -1 ? "" : file.path.slice(0, slash);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  const rank = (folder: string) => {
    const index = FOLDER_ORDER.indexOf(folder);
    return folder === "" ? 1000 : index === -1 ? 100 : index;
  };
  return [...groups.entries()].toSorted(
    ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b),
  );
}

function StoreFiles({
  environmentId,
  store,
  initialOpen,
  onChanged,
  onAsk,
}: {
  environmentId: EnvironmentId;
  store: string;
  initialOpen: string | null;
  onChanged: () => void;
  onAsk: (file: string) => void;
}) {
  const [files, setFiles] = useState<MemoryFileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(initialOpen);
  useScrollIntoView(files !== null ? initialOpen : null, "data-file");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .files(environmentId, store)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setTruncated(result.truncated);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store, signal]);

  const remove = async (file: string) => {
    const ok = await confirm(
      `Delete ${file} from ${store}? The deletion is committed, so git history keeps the old version.`,
      true,
    );
    if (!ok) return;
    try {
      await rubatoMemory.deleteFile(environmentId, store, file);
      toastManager.add({ type: "success", title: `Deleted ${file}` });
      if (open === file) setOpen(null);
      setSignal((value) => value + 1);
      onChanged();
    } catch (cause) {
      reportError(`Could not delete ${file}`, cause);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = files?.filter(
    (file) => needle === "" || `${file.path} ${file.description ?? ""}`.toLowerCase().includes(needle),
  );

  return (
    <SettingsSection
      id="memory-files"
      title={files ? `What it keeps · ${count(files.length, "file")}` : "What it keeps"}
      headerAction={
        files && files.length > 0 ? (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              className="w-48 ps-7"
              placeholder="Find a file"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              aria-label="Find a file"
            />
          </div>
        ) : null
      }
    >
      {error ? <SettingsRow title="Could not load files" description={error} /> : null}
      {files === null && !error ? (
        <SettingsRow title="Loading files" control={<Spinner className="size-4" />} />
      ) : null}
      {files?.length === 0 ? <SettingsRow title="Nothing saved yet" /> : null}
      {shown && files && files.length > 0 && shown.length === 0 ? <SettingsRow title="No file matches" /> : null}
      {shown
        ? groupFiles(shown).map(([folder, entries]) => (
            // Folders start closed; a search, or the file the user came for, opens the folder it is in.
            <details
              key={`${folder || "."}:${needle !== ""}`}
              open={needle !== "" || (initialOpen !== null && entries.some((file) => file.path === initialOpen))}
              className="group px-3 py-2 sm:px-4"
            >
              <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm font-medium">
                <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                {folder ? `${folder}/` : "Top level"}
                <span className="text-xs font-normal text-muted-foreground">{entries.length}</span>
              </summary>
              <ul className="mt-1 space-y-0.5">
                {entries.map((file) => (
                  <li key={file.path}>
                    <div className="group/file flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        aria-expanded={open === file.path}
                        data-file={file.path}
                        onClick={() => setOpen(open === file.path ? null : file.path)}
                      >
                        <span className="block truncate font-mono text-xs text-foreground">
                          {folder ? file.path.slice(folder.length + 1) : file.path}
                        </span>
                        {file.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {file.description}
                          </span>
                        ) : null}
                      </button>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${file.path}`}
                        onClick={() => void remove(file.path)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                    {open === file.path ? (
                      <FileViewer
                        environmentId={environmentId}
                        store={store}
                        path={file.path}
                        onAsk={() => onAsk(file.path)}
                        onSaved={() => {
                          setSignal((value) => value + 1);
                          onChanged();
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ))
        : null}
      {truncated ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">Showing the first 5,000 files.</p>
      ) : null}
    </SettingsSection>
  );
}

function FileViewer({
  environmentId,
  store,
  path,
  onAsk,
  onSaved,
}: {
  environmentId: EnvironmentId;
  store: string;
  path: string;
  onAsk: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .file(environmentId, store, path)
      .then((result) => {
        if (!cancelled) setContent({ text: result.content, truncated: result.truncated });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store, path]);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      const result = await rubatoMemory.saveFile(environmentId, store, path, draft, message.trim() || undefined);
      toastManager.add({ type: "success", title: result.commit ? `Saved ${path}` : `No changes to ${path}` });
      setContent({ text: result.content, truncated: false });
      setDraft(null);
      setMessage("");
      onSaved();
    } catch (cause) {
      reportError(`Could not save ${path}`, cause);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="px-2 pb-2 text-sm text-destructive-foreground">{error}</p>;
  if (!content)
    return (
      <div className="flex items-center gap-2 px-2 pb-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </div>
    );
  if (draft !== null)
    return (
      <div className="mx-2 mb-2 space-y-2">
        <Textarea
          aria-label={`Edit ${path}`}
          className="font-mono text-xs"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          rows={18}
        />
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            className="flex-1"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="What you changed (optional, kept in the history)"
            aria-label="Commit message"
          />
          <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button size="xs" disabled={saving || draft === content.text} onClick={() => void save()}>
            {saving ? <Spinner className="size-3" /> : null}
            Save
          </Button>
        </div>
      </div>
    );
  const body = path.endsWith(".md") ? content.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : null;
  return (
    <div className="mx-2 mb-2 rounded-lg border border-border/60">
      <div className="flex justify-end gap-1 px-2 pt-2">
        <Button size="xs" variant="ghost" onClick={onAsk}>
          <MessageSquareIcon className="size-3" />
          Ask in chat
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={content.truncated}
          title={content.truncated ? "Too large to edit here" : undefined}
          onClick={() => setDraft(content.text)}
        >
          <PencilIcon className="size-3" />
          Edit
        </Button>
      </div>
      <div className="max-h-[32rem] overflow-auto px-4 pb-3">
        {body !== null ? (
          <ChatMarkdown text={body} cwd={undefined} />
        ) : (
          <pre className="font-mono text-xs whitespace-pre-wrap">{content.text}</pre>
        )}
        {content.truncated ? (
          <p className="mt-2 text-xs text-muted-foreground">Showing the first 1 MB.</p>
        ) : null}
      </div>
    </div>
  );
}

/** What the dreams noticed about the user, from every project, waiting to be added to user.md or dismissed. */
function SuggestionsSection({
  environmentId,
  suggestions,
  onChanged,
}: {
  environmentId: EnvironmentId;
  suggestions: readonly DreamSuggestion[];
  onChanged: () => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"add" | "dismiss" | null>(null);
  const allChosen = chosen.size === suggestions.length;

  const act = async (kind: "add" | "dismiss") => {
    const lines = suggestions.map((entry) => entry.text).filter((text) => chosen.has(text));
    setBusy(kind);
    try {
      if (kind === "add") {
        const result = await rubatoMemory.addSuggestions(environmentId, lines);
        toastManager.add({ type: "success", title: `Added ${count(result.added, "line")} to user.md` });
        window.dispatchEvent(new CustomEvent("rubato-memory-self-changed"));
      } else {
        await rubatoMemory.dismissSuggestions(environmentId, lines);
      }
      setChosen(new Set());
      onChanged();
    } catch (cause) {
      reportError(kind === "add" ? "Could not add to user.md" : "Could not dismiss", cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      id="memory-suggestions"
      title={`The dream noticed about you · ${suggestions.length}`}
      headerAction={
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => setChosen(allChosen ? new Set() : new Set(suggestions.map((entry) => entry.text)))}>
            {allChosen ? "Select none" : "Select all"}
          </Button>
          <Button size="xs" variant="ghost" disabled={chosen.size === 0 || busy !== null} onClick={() => void act("dismiss")}>
            {busy === "dismiss" ? <Spinner className="size-3" /> : null}
            Dismiss
          </Button>
          <Button size="xs" disabled={chosen.size === 0 || busy !== null} onClick={() => void act("add")}>
            {busy === "add" ? <Spinner className="size-3" /> : null}
            Add {chosen.size > 0 ? count(chosen.size, "line") : ""} to user.md
          </Button>
        </div>
      }
    >
      <SettingsRow
        title="From your sessions"
        description="Add the ones every session should know about you. Dismissed lines do not come back."
      >
        <ul className="space-y-1.5 pt-2 pb-3">
          {suggestions.map((entry) => (
            <li key={entry.text} className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                aria-label={entry.text}
                checked={chosen.has(entry.text)}
                onCheckedChange={(checked) =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (checked) next.add(entry.text);
                    else next.delete(entry.text);
                    return next;
                  })
                }
              />
              <span className="min-w-0">
                {entry.text}
                <span className="ms-2 text-xs text-muted-foreground">{entry.store}</span>
              </span>
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}

function SelfFilesSection({ environmentId }: { environmentId: EnvironmentId }) {
  const [file, setFile] = useState<"user.md" | "soul.md">("user.md");
  const [saved, setSaved] = useState<{ "user.md": string; "soul.md": string } | null>(null);
  const [drafts, setDrafts] = useState<{ "user.md": string; "soul.md": string } | null>(null);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const result = await rubatoMemory.self(environmentId);
      const next = { "user.md": result.user, "soul.md": result.soul };
      setSaved(next);
      setDrafts((current) => {
        if (current === null) return next;
        // Keep what the user is typing; take the file for anything untouched.
        return {
          "user.md": current["user.md"] === saved?.["user.md"] ? next["user.md"] : current["user.md"],
          "soul.md": current["soul.md"] === saved?.["soul.md"] ? next["soul.md"] : current["soul.md"],
        };
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId, saved]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
    const reload = () => void loadRef.current();
    window.addEventListener("rubato-memory-self-changed", reload);
    return () => window.removeEventListener("rubato-memory-self-changed", reload);
  }, [environmentId]);

  const dirty = saved !== null && drafts !== null && drafts[file] !== saved[file];
  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    try {
      const result = await rubatoMemory.saveSelf(environmentId, file, drafts[file], summary.trim() || undefined);
      setSummary("");
      toastManager.add({
        type: "success",
        title: result.commit ? `Saved and committed ${file}` : `No changes to ${file}`,
      });
      const content = drafts[file].length === 0 || drafts[file].endsWith("\n") ? drafts[file] : `${drafts[file]}\n`;
      setSaved((current) => (current ? { ...current, [file]: content } : current));
      setDrafts((current) => (current ? { ...current, [file]: content } : current));
    } catch (cause) {
      reportError(`Could not save ${file}`, cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      id="memory-self"
      title="About you"
      headerAction={
        <div className="flex gap-1">
          {(["user.md", "soul.md"] as const).map((name) => (
            <Button
              key={name}
              size="xs"
              variant={file === name ? "secondary" : "ghost"}
              onClick={() => setFile(name)}
            >
              {name}
              {saved && drafts && drafts[name] !== saved[name] ? " •" : ""}
            </Button>
          ))}
        </div>
      }
    >
      <SettingsRow
        title={file === "user.md" ? "user.md — who you are" : "soul.md — how the agent works with you"}
        description="Every session starts with these. Each save is committed to the self memory store."
      >
        {error ? <p className="pb-3 text-sm text-destructive-foreground">{error}</p> : null}
        {drafts === null && !error ? (
          <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground">
            <Spinner className="size-3.5" /> Loading
          </div>
        ) : null}
        {drafts ? (
          <div className="space-y-2 pt-2 pb-3">
            <Textarea
              aria-label={file}
              className="font-mono text-xs"
              value={drafts[file]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDrafts((current) => (current ? { ...current, [file]: value } : current));
              }}
              rows={14}
              placeholder={file === "user.md" ? "- Prefers short answers" : "- Lead with the conclusion"}
            />
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                className="flex-1"
                value={summary}
                onChange={(event) => setSummary(event.currentTarget.value)}
                placeholder="Commit message (optional)"
                aria-label="Commit message"
              />
              <Button
                size="xs"
                variant="ghost"
                disabled={!dirty || saving}
                onClick={() =>
                  setDrafts((current) => (current && saved ? { ...current, [file]: saved[file] } : current))
                }
              >
                Revert
              </Button>
              <Button size="xs" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <Spinner className="size-3" /> : null}
                Save
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

const REASONING_LEVELS: readonly DreamReasoning[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_REASONING = "__default__";

/** The Rubato instance's catalogue: every model a dream could run on. */
function useRubatoModels(): ReadonlyArray<{ slug: string; name: string }> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return providers.find((provider) => provider.driver === "rubato-pi")?.models ?? [];
}

function ModelIcon({ slug }: { slug: string }) {
  const Icon = iconForProviderModel("rubato-pi" as never, { slug });
  return Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null;
}

export function DreamModelsEditor({
  models,
  onChange,
}: {
  models: readonly DreamModel[];
  onChange: (next: readonly DreamModel[]) => void;
}) {
  const catalogue = useRubatoModels();
  const nameOf = (slug: string) => catalogue.find((model) => model.slug === slug)?.name ?? slug;
  const addable = catalogue.filter((model) => !models.some((entry) => entry.model === model.slug));
  const move = (index: number, by: -1 | 1) => {
    const next = [...models];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const update = (index: number, reasoning: DreamReasoning | null) =>
    onChange(models.map((entry, at) => (at === index ? { ...entry, reasoning } : entry)));
  const remove = (index: number) => onChange(models.filter((_, at) => at !== index));

  return (
    <SettingsRow
      title="Models"
      description="The dream tries these in order and uses the first one that answers."
    >
      <ol className="mt-3 space-y-1.5">
        {models.map((entry, index) => (
          <li
            key={entry.model}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5"
          >
            <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
            <ModelIcon slug={entry.model} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{nameOf(entry.model)}</span>
              {!catalogue.some((model) => model.slug === entry.model) ? (
                <span className="block text-xs text-warning">Not in the current model list</span>
              ) : null}
            </span>
            <Select
              value={entry.reasoning ?? DEFAULT_REASONING}
              onValueChange={(next) => {
                if (typeof next !== "string") return;
                update(index, next === DEFAULT_REASONING ? null : (next as DreamReasoning));
              }}
            >
              <SelectTrigger size="sm" className="w-32" aria-label={`Reasoning for ${nameOf(entry.model)}`}>
                <SelectValue>{entry.reasoning ?? "Default"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT_REASONING}>Default</SelectItem>
                {REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="icon-xs" variant="ghost" disabled={index === 0} aria-label="Move up" onClick={() => move(index, -1)}>
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={index === models.length - 1}
              aria-label="Move down"
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={models.length === 1}
              aria-label={`Remove ${nameOf(entry.model)}`}
              title={models.length === 1 ? "The dream needs at least one model" : undefined}
              onClick={() => remove(index)}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      {addable.length > 0 && models.length < 8 ? (
        <div className="mt-2">
          <Select
            value=""
            onValueChange={(next) => {
              if (typeof next === "string" && next) onChange([...models, { model: next, reasoning: null }]);
            }}
          >
            <SelectTrigger size="sm" aria-label="Add a model to the dream">
              <SelectValue>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <PlusIcon className="size-3.5" /> Add model
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {addable.map((model) => (
                <SelectItem key={model.slug} value={model.slug}>
                  <span className="inline-flex items-center gap-2">
                    <ModelIcon slug={model.slug} />
                    {model.name}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-0.5 hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="pt-1 pb-2">{children}</div>
    </details>
  );
}
