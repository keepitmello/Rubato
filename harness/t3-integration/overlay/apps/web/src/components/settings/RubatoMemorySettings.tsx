import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  Undo2Icon,
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
  type DreamPublish,
  type DreamReasoning,
  type DreamRunDetail,
  type DreamRunSummary,
  type MemoryFileEntry,
  type MemoryStatus,
  type MemoryStoreStatus,
  type MemoryStoreSummary,
  type ProjectStore,
  type StoreInbox,
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
import { addedContent, askPrompt, projectForStore, runLabel, type BadgeVariant } from "./RubatoMemorySettings.logic";
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
function useReadyEnvironmentId(): EnvironmentId {
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
  if (store.home) return "Home folder";
  if (store.roots && store.roots.length > 0) return store.roots.map((root) => tildePath(root, home)).join(", ");
  return "Project folder unknown";
}

type Tab = "stores" | "you" | "dreams";
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "stores", label: "Stores" },
  { value: "you", label: "About you" },
  { value: "dreams", label: "Dream settings" },
];

export function RubatoMemorySettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [summaries, setSummaries] = useState<MemoryStoreSummary[] | null>(null);
  const [memoryRoot, setMemoryRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stores");
  const [historySignal, setHistorySignal] = useState(0);
  const loadingRef = useRef(false);

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
  }, [environmentId, loadStores]);

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

  // After a review action the store list (what needs the user) and any open history are stale.
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
  const setPublish = (publish: DreamPublish) => {
    const previous = status;
    if (previous) setStatus({ ...previous, publish });
    void saveConfig({ publish }, () => setStatus(previous));
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
        description: "This can take several minutes. What it changes shows up at the top of Memory.",
      });
      await refresh();
    } catch (error) {
      reportError("Could not start the dream", error);
    }
  };

  const selected = selectedStore ? stores?.find((entry) => entry.store === selectedStore) : undefined;
  if (selectedStore && stores && !selected) {
    // Deleted, or gone from disk since the list was read.
    setSelectedStore(null);
  }

  if (selected) {
    return (
      <SettingsPageContainer>
        <StoreDetail
          environmentId={environmentId}
          store={selected}
          home={home}
          historySignal={historySignal}
          onBack={() => setSelectedStore(null)}
          onToggle={(enabled) => setEnabled(selected.store, enabled)}
          onRun={() => void runNow(selected.store)}
          onChanged={changed}
          onDeleted={() => {
            setSelectedStore(null);
            void refresh();
          }}
        />
      </SettingsPageContainer>
    );
  }

  const inbox = stores?.filter((store): store is StoreView & { inbox: StoreInbox } => store.inbox !== null) ?? [];

  return (
    <SettingsPageContainer>
      {inbox.length > 0 ? (
        <SettingsSection id="memory-review" title={inbox.length === 1 ? "To review" : `To review · ${inbox.length}`}>
          {inbox.map((store) => (
            <div key={`${store.store}:${store.inbox.runId}`} className="px-3 py-3 sm:px-4">
              <RunView
                environmentId={environmentId}
                store={store}
                home={home}
                runId={store.inbox.runId}
                inbox={store.inbox.kind}
                showHeader
                onChanged={changed}
              />
            </div>
          ))}
        </SettingsSection>
      ) : null}

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
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      {tab === "stores" ? (
        <SettingsSection
          id="memory-stores"
          title="Stores"
          headerAction={
            <Button size="xs" variant="ghost" disabled={loading} onClick={() => void refresh()}>
              {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
              Refresh
            </Button>
          }
        >
          {storesError ? <SettingsRow title="Could not load memory stores" description={storesError} /> : null}
          {stores === null && !storesError ? (
            <SettingsRow title="Loading memory stores" control={<Spinner className="size-4" />} />
          ) : null}
          {stores?.length === 0 ? (
            <SettingsRow
              title="No memory yet"
              description="Memory is created automatically the first time the agent saves something in a project."
            />
          ) : null}
          {stores?.map((store) => (
            <StoreRow
              key={store.store}
              store={store}
              home={home}
              onOpen={() => setSelectedStore(store.store)}
              onToggle={(enabled) => setEnabled(store.store, enabled)}
            />
          ))}
        </SettingsSection>
      ) : null}

      {tab === "you" ? <SelfFilesSection environmentId={environmentId} /> : null}

      {tab === "dreams" ? (
        <>
          <SettingsSection id="memory-dream" title="Dreams">
            {statusError ? (
              <SettingsRow title="Could not load dream settings" description={statusError} />
            ) : status === null ? (
              <SettingsRow
                title="Loading dream settings"
                description="Scanning sessions can take a few seconds."
                control={<Spinner className="size-4" />}
              />
            ) : (
              <>
                <DreamModelsEditor models={status.models} onChange={setModels} />
                <SettingsRow
                  title="When a dream changes memory"
                  description={
                    status.publish === "review"
                      ? "Its changes wait at the top of Memory until you accept or discard them."
                      : "Its changes go into memory right away. They show at the top of Memory until you mark them seen, and you can undo them."
                  }
                  control={
                    <Select
                      value={status.publish}
                      onValueChange={(next) => {
                        if (next === "review" || next === "auto") setPublish(next);
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="Dream publish mode">
                        <SelectValue>{status.publish === "review" ? "Ask me first" : "Apply, then show me"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value="review">Ask me first</SelectItem>
                        <SelectItem value="auto">Apply, then show me</SelectItem>
                      </SelectPopup>
                    </Select>
                  }
                />
              </>
            )}
          </SettingsSection>
          <ProjectStoresSection
            environmentId={environmentId}
            home={home}
            stores={stores?.map((store) => store.store) ?? []}
            onChanged={() => void refresh()}
          />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

function StoreBadges({ store }: { store: StoreView }) {
  const last = store.lastGuiRun;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {store.running ? (
        <Badge variant="info">
          <Spinner className="size-3" />
          Dreaming {store.running.startedAt ? `(started ${ago(store.running.startedAt)})` : ""}
        </Badge>
      ) : null}
      {store.inbox?.kind === "pending" ? <Badge variant="warning">Needs review</Badge> : null}
      {store.inbox?.kind === "landed" ? <Badge variant="info">New in memory</Badge> : null}
      {store.due && !store.running ? <Badge variant="secondary">Dream due</Badge> : null}
      {!store.running && last && last.status === "failed" ? (
        <span className="text-destructive-foreground" title={last.reason}>
          Last run failed: {(last.reason ?? "").split("\n")[0]}
        </span>
      ) : null}
    </span>
  );
}

function storeFacts(store: StoreView): string {
  return [
    count(store.files, "file"),
    store.lastChangeAt ? `Updated ${ago(store.lastChangeAt)}` : "No changes yet",
    store.lastDreamAt ? `Last dream ${ago(store.lastDreamAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function StoreRow({
  store,
  home,
  onOpen,
  onToggle,
}: {
  store: StoreView;
  home: string | null;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
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
      status={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{storeFacts(store)}</span>
          <StoreBadges store={store} />
        </span>
      }
      control={
        <span
          className="flex items-center gap-2"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="text-xs text-muted-foreground">Dreams</span>
          <Switch
            aria-label={`Dreams for ${store.store}`}
            checked={store.enabled}
            onCheckedChange={(enabled) => onToggle(enabled)}
          />
          <Button size="icon-xs" variant="ghost" aria-label={`Open ${store.store}`} onClick={onOpen}>
            <ChevronRightIcon className="size-4" />
          </Button>
        </span>
      }
    />
  );
}

function StoreDetail({
  environmentId,
  store,
  home,
  historySignal,
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
  onBack: () => void;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const deleteStore = async () => {
    const ok = await confirm(
      `Delete the memory store "${store.store}"? It is archived to ~/.rubato/backups first. If an agent saves memory in this project again, a new empty store is created.`,
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
      reportError("Could not delete the store", error);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div>
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          All stores
        </Button>
      </div>
      <SettingsSection id="memory-store" title={store.store}>
        <SettingsRow
          title={whereLabel(store, home)}
          description={storeFacts(store)}
          status={<StoreBadges store={store} />}
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
              <span className="text-xs text-muted-foreground">Dreams</span>
              <Switch
                aria-label={`Dreams for ${store.store}`}
                checked={store.enabled}
                onCheckedChange={(enabled) => onToggle(enabled)}
              />
            </>
          }
        />
      </SettingsSection>

      {store.inbox ? (
        <SettingsSection id="memory-store-review" title="To review">
          <div className="px-3 py-3 sm:px-4">
            <RunView
              key={`${store.inbox.runId}:${historySignal}`}
              environmentId={environmentId}
              store={store}
              home={home}
              runId={store.inbox.runId}
              inbox={store.inbox.kind}
              onChanged={onChanged}
            />
          </div>
        </SettingsSection>
      ) : null}

      <DreamHistory
        key={`${store.store}:${historySignal}`}
        environmentId={environmentId}
        store={store}
        home={home}
        onChanged={onChanged}
      />

      <StoreFiles environmentId={environmentId} store={store.store} onChanged={onChanged} />

      <SettingsSection id="memory-store-delete" title="Delete">
        <SettingsRow
          title="Delete store"
          description="Archives the store to ~/.rubato/backups, then removes it from memory."
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={deleting || store.running !== null}
              onClick={() => void deleteStore()}
            >
              {deleting ? <Spinner className="size-3" /> : <Trash2Icon className="size-3" />}
              Delete store…
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}

/** Opens a new thread in the store's project with the run in the composer; the user picks a model and asks. */
function useAskInChat(environmentId: EnvironmentId, store: StoreView, home: string | null) {
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  return async (detail: DreamRunDetail, file?: string) => {
    const candidates = projects.filter((project) => project.environmentId === environmentId);
    const project = projectForStore(candidates, store.home && home ? [home] : store.roots);
    if (!project) {
      toastManager.add({
        type: "error",
        title: "No project for this store",
        description: `Add ${whereLabel(store, home)} as a project, then ask again.`,
      });
      return;
    }
    const opened = await newThread(scopeProjectRef(project.environmentId, project.id)).catch(() => null);
    if (!opened) {
      toastManager.add({ type: "error", title: "Could not open a thread", description: "Open one from the project, then ask again." });
      return;
    }
    useComposerDraftStore.getState().setPrompt(opened.draftId, askPrompt(detail, file));
  };
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

/**
 * One dream as a decision: what it says it did, one card per file it changed, and the action the
 * run is waiting for. The report, the sessions and what it left out stay folded below.
 */
function RunView({
  environmentId,
  store,
  home,
  runId,
  inbox,
  showHeader = false,
  onChanged,
}: {
  environmentId: EnvironmentId;
  store: StoreView;
  home: string | null;
  runId: string;
  inbox?: StoreInbox["kind"];
  showHeader?: boolean;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<DreamRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "revert" | "ack" | "candidates" | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [signal, setSignal] = useState(0);
  const ask = useAskInChat(environmentId, store, home);

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
  }, [environmentId, store.store, runId, signal]);

  const act = async (kind: "approve" | "reject" | "revert" | "ack") => {
    if (kind === "reject" && !(await confirm("Discard this dream's changes? What it read stays marked as read.", true)))
      return;
    if (kind === "revert" && !(await confirm(`Undo this dream? One commit takes its changes back out of ${store.store}.`)))
      return;
    setBusy(kind);
    try {
      if (kind === "approve" || kind === "reject") await rubatoMemory.review(environmentId, store.store, kind);
      else if (kind === "revert") await rubatoMemory.revert(environmentId, store.store, runId);
      else await rubatoMemory.ack(environmentId, store.store, runId);
      if (kind !== "ack")
        toastManager.add({
          type: "success",
          title: kind === "approve" ? "Added to memory" : kind === "reject" ? "Changes discarded" : "Dream undone",
        });
      setSignal((value) => value + 1);
      onChanged();
    } catch (cause) {
      reportError(
        kind === "approve" ? "Could not add to memory" : kind === "reject" ? "Could not discard" : kind === "revert" ? "Could not undo" : "Could not mark as seen",
        cause,
      );
    } finally {
      setBusy(null);
    }
  };

  const addChosen = async () => {
    setBusy("candidates");
    try {
      const result = await rubatoMemory.addCandidates(environmentId, store.store, runId, [...chosen]);
      toastManager.add({
        type: "success",
        title: result.added > 0 ? `Added ${count(result.added, "line")} to user.md` : "Already in user.md",
      });
      setChosen(new Set());
      setSignal((value) => value + 1);
      window.dispatchEvent(new CustomEvent("rubato-memory-self-changed"));
    } catch (cause) {
      reportError("Could not add to user.md", cause);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (!detail)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </div>
    );

  const cards = showAll ? detail.changes : detail.changes.slice(0, CARDS_SHOWN);
  const label = runLabel(detail);
  const blocked = detail.uncommitted.length > 0;
  return (
    <div className="space-y-3">
      {showHeader ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{store.store}</span>
          <Badge variant={inbox === "landed" ? "info" : label.variant}>{inbox === "landed" ? "New in memory" : label.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {[stamp(detail.startedAt), `${count(detail.sessions, "session")} read`, detail.model]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      ) : null}

      {detail.summary ? <p className="text-sm text-foreground/90">{detail.summary}</p> : null}

      {detail.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {detail.diffNote && detail.diffNote !== "truncated"
            ? `Could not read the changes: ${detail.diffNote}`
            : "This dream changed no files."}
        </p>
      ) : (
        <ul className="space-y-2">
          {cards.map((change) => (
            <ChangeCard key={change.path} change={change} onAsk={() => void ask(detail, change.path)} />
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

      {detail.candidates.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="me-auto text-sm">The dream noticed these about you</span>
            <Button size="xs" variant="outline" disabled={chosen.size === 0 || busy !== null} onClick={() => void addChosen()}>
              {busy === "candidates" ? <Spinner className="size-3" /> : null}
              Add {count(chosen.size, "line")} to user.md
            </Button>
          </div>
          <ul className="space-y-1.5">
            {detail.candidates.map((candidate) => (
              <li key={candidate.text} className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  aria-label={candidate.text}
                  disabled={candidate.inUser}
                  checked={candidate.inUser || chosen.has(candidate.text)}
                  onCheckedChange={(checked) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (checked) next.add(candidate.text);
                      else next.delete(candidate.text);
                      return next;
                    })
                  }
                />
                <span className={cn(candidate.inUser && "text-muted-foreground")}>
                  {candidate.text}
                  {candidate.inUser ? " (in user.md)" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1 text-xs text-muted-foreground">
        {detail.skipped.length > 0 ? (
          <Fold label={`Left out · ${detail.skipped.length}`}>
            <ul className="list-disc space-y-0.5 ps-4">
              {detail.skipped.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Fold>
        ) : null}
        {detail.report ? (
          <Fold label="Full report">
            <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-border/60 px-3 py-2 text-sm text-foreground">
              <ChatMarkdown text={detail.report} cwd={undefined} />
            </div>
          </Fold>
        ) : null}
        {detail.sessionList.length > 0 ? (
          <Fold label={`Sessions read · ${detail.sessionList.length}`}>
            <ul className="space-y-0.5 ps-4">
              {detail.sessionList.map((session) => (
                <li key={session.id} className="truncate">
                  {session.name ?? session.id}
                  {session.messages !== undefined ? ` · ${count(session.messages, "message")}` : ""}
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
      </div>

      {blocked ? (
        <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
          <p>
            {detail.pending ? "Can't add this yet" : "Can't undo this yet"}: {store.store} has edits that were never
            committed, most likely from a session that stopped mid-write.
          </p>
          <ul className="mt-1 font-mono text-xs text-muted-foreground">
            {detail.uncommitted.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            Commit or drop them first. Ask in chat hands them to an agent along with this dream.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={() => void ask(detail)}>
          <MessageSquareIcon className="size-3.5" />
          Ask in chat
        </Button>
        <span className="me-auto" />
        {detail.pending ? (
          <>
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act("reject")}>
              {busy === "reject" ? <Spinner className="size-3" /> : null}
              Discard
            </Button>
            <Button size="xs" disabled={busy !== null || blocked} onClick={() => void act("approve")}>
              {busy === "approve" ? <Spinner className="size-3" /> : null}
              Add to memory
            </Button>
          </>
        ) : null}
        {detail.landed ? (
          <Button size="xs" variant="outline" disabled={busy !== null || blocked} onClick={() => void act("revert")}>
            {busy === "revert" ? <Spinner className="size-3" /> : <Undo2Icon className="size-3" />}
            Undo
          </Button>
        ) : null}
        {inbox === "landed" && detail.landed ? (
          <Button size="xs" disabled={busy !== null} onClick={() => void act("ack")}>
            {busy === "ack" ? <Spinner className="size-3" /> : null}
            Got it
          </Button>
        ) : null}
      </div>
    </div>
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

function ChangeCard({ change, onAsk }: { change: DreamChange; onAsk: () => void }) {
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
        <Button size="icon-xs" variant="ghost" aria-label={`Ask in chat about ${change.path}`} title="Ask in chat" onClick={onAsk}>
          <MessageSquareIcon className="size-3.5" />
        </Button>
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

function DreamHistory({
  environmentId,
  store,
  home,
  onChanged,
}: {
  environmentId: EnvironmentId;
  store: StoreView;
  home: string | null;
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<DreamRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

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
    <SettingsSection id="memory-history" title="Dream history">
      {error ? <SettingsRow title="Could not load the history" description={error} /> : null}
      {runs === null && !error ? (
        <SettingsRow title="Loading history" control={<Spinner className="size-4" />} />
      ) : null}
      {runs?.length === 0 ? <SettingsRow title="No dreams yet" /> : null}
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
              run.model ?? "No model",
              `${count(run.sessions, "session")} read`,
              run.reason ?? null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {expanded ? (
              <div className="pt-1 pb-3">
                <RunView environmentId={environmentId} store={store} home={home} runId={run.runId} onChanged={onChanged} />
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
  onChanged,
}: {
  environmentId: EnvironmentId;
  store: string;
  onChanged: () => void;
}) {
  const [files, setFiles] = useState<MemoryFileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
      `Delete ${file} from ${store}? The deletion is committed to the store, so git history keeps the old version.`,
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
      title={files ? `Files · ${files.length}` : "Files"}
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
      {files?.length === 0 ? <SettingsRow title="This store has no files yet" /> : null}
      {shown && files && files.length > 0 && shown.length === 0 ? <SettingsRow title="No file matches" /> : null}
      {shown
        ? groupFiles(shown).map(([folder, entries]) => (
            // Folders start closed; a search opens every folder it matches in.
            <details key={`${folder || "."}:${needle !== ""}`} open={needle !== ""} className="group px-3 py-2 sm:px-4">
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
                      <FileViewer environmentId={environmentId} store={store} path={file.path} />
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
}: {
  environmentId: EnvironmentId;
  store: string;
  path: string;
}) {
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (error) return <p className="px-2 pb-2 text-sm text-destructive-foreground">{error}</p>;
  if (!content)
    return (
      <div className="flex items-center gap-2 px-2 pb-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </div>
    );
  const body = path.endsWith(".md") ? content.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : null;
  return (
    <div className="mx-2 mb-2 max-h-[32rem] overflow-auto rounded-lg border border-border/60 px-4 py-3">
      {body !== null ? (
        <ChatMarkdown text={body} cwd={undefined} />
      ) : (
        <pre className="font-mono text-xs whitespace-pre-wrap">{content.text}</pre>
      )}
      {content.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">Showing the first 1 MB.</p>
      ) : null}
    </div>
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

function DreamModelsEditor({
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

const AUTOMATIC = "__automatic__";
const NEW_STORE = "__new__";
const STORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function projectStoreLabel(entry: ProjectStore | undefined): string {
  if (!entry) return "Checking…";
  if (entry.configured) return `Writes to ${entry.configured}, named in .rubato/rubato.jsonc.`;
  if (entry.source === "git") return `Writes to ${entry.store}, found from its git repository.`;
  if (entry.source === "home") return "Writes to home, the home folder's store.";
  return "Keeps no memory: not a git repository and no store named.";
}

/** Each project in the app and the store its sessions write to; naming one writes memory.agent. */
function ProjectStoresSection({
  environmentId,
  home,
  stores,
  onChanged,
}: {
  environmentId: EnvironmentId;
  home: string | null;
  stores: readonly string[];
  onChanged: () => void;
}) {
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [allProjects, environmentId],
  );
  const dirsKey = projects.map((project) => project.workspaceRoot).join("\n");
  const [resolved, setResolved] = useState<ReadonlyMap<string, ProjectStore>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (environmentId === null || dirsKey === "") return;
    try {
      const result = await rubatoMemory.projects(environmentId, dirsKey.split("\n"));
      setResolved(new Map(result.projects.map((entry) => [entry.dir, entry])));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId, dirsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (dir: string, store: string | null) => {
    setSaving(dir);
    try {
      await rubatoMemory.setProjectStore(environmentId, dir, store);
      setNaming(null);
      setNewName("");
      await load();
      onChanged();
      toastManager.add({
        type: "info",
        title: store ? `Sessions here now write to ${store}` : "Back to the automatic store",
        description: "New sessions pick this up; running ones keep their store.",
      });
    } catch (cause) {
      reportError("Could not change the project's store", cause);
    } finally {
      setSaving(null);
    }
  };

  if (projects.length === 0) return null;
  return (
    <SettingsSection id="memory-projects" title="Which store each project writes to">
      {error ? <SettingsRow title="Could not read the projects' stores" description={error} /> : null}
      {projects.map((project) => {
        const dir = project.workspaceRoot;
        const entry = resolved.get(dir);
        const options = [...new Set([...stores, ...(entry?.configured ? [entry.configured] : [])])].toSorted();
        return (
          <SettingsRow
            key={`${project.environmentId}:${project.id}`}
            title={project.title}
            description={
              <span className="block truncate" title={dir}>
                {tildePath(dir, home)}
              </span>
            }
            status={projectStoreLabel(entry)}
            control={
              naming === dir ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (STORE_NAME.test(newName.trim())) void save(dir, newName.trim());
                  }}
                >
                  <Input
                    autoFocus
                    size="sm"
                    className="w-40"
                    placeholder="store name"
                    value={newName}
                    onChange={(event) => setNewName(event.currentTarget.value)}
                    aria-label={`New memory store for ${project.title}`}
                  />
                  <Button size="sm" type="submit" disabled={saving === dir || !STORE_NAME.test(newName.trim())}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <Select
                  value={entry?.configured ?? AUTOMATIC}
                  onValueChange={(next) => {
                    if (typeof next !== "string") return;
                    if (next === NEW_STORE) {
                      setNaming(dir);
                      setNewName("");
                    } else if (next === AUTOMATIC) {
                      if (entry?.configured) void save(dir, null);
                    } else if (next !== entry?.configured) void save(dir, next);
                  }}
                >
                  <SelectTrigger size="sm" className="w-44" aria-label={`Memory store for ${project.title}`} disabled={saving === dir || !entry}>
                    <SelectValue>{entry?.configured ?? "Automatic"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
                    {options.map((store) => (
                      <SelectItem key={store} value={store}>
                        {store}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_STORE}>New store…</SelectItem>
                  </SelectPopup>
                </Select>
              )
            }
          />
        );
      })}
    </SettingsSection>
  );
}
