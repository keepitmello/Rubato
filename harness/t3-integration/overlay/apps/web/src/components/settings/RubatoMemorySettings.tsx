import { ChevronDownIcon, ChevronRightIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import {
  rubatoMemory,
  type DreamPublish,
  type DreamRunDetail,
  type DreamRunSummary,
  type MemoryStatus,
  type MemoryStoreStatus,
} from "../../state/rubatoMemory";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

const STATUS_LABEL: Record<string, { label: string; variant: "success" | "warning" | "error" | "info" | "secondary" | "outline" }> = {
  merged: { label: "Merged", variant: "success" },
  pending: { label: "Needs review", variant: "warning" },
  noop: { label: "No changes", variant: "secondary" },
  failed: { label: "Failed", variant: "error" },
  busy: { label: "Already running", variant: "secondary" },
  trial: { label: "Trial", variant: "info" },
};

function runLabel(run: Pick<DreamRunSummary, "status" | "review" | "pending">) {
  if (run.review === "rejected") return { label: "Rejected", variant: "secondary" as const };
  if (run.status === "pending" && run.review === "merged") return STATUS_LABEL.merged!;
  if (run.status === "pending" && !run.pending) return { label: "Reviewed", variant: "secondary" as const };
  return STATUS_LABEL[run.status] ?? { label: run.status, variant: "outline" as const };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string | undefined): string {
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

/** Stores worth a row by default: the ones in use. Test leftovers wait behind a toggle. */
function isActive(store: MemoryStoreStatus) {
  return (
    store.enabled ||
    store.pendingRunId !== undefined ||
    store.running !== null ||
    store.lastDreamAt !== undefined
  );
}

/** The primary environment's id once its HTTP connection is ready; null until then. */
function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

export function RubatoMemorySettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [historySignal, setHistorySignal] = useState(0);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (environmentId === null || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const next = await rubatoMemory.status(environmentId);
      setStatus(next);
      setLoadError(null);
      setSelectedStore(
        (current) =>
          current ??
          next.stores.find((store) => store.pendingRunId !== undefined)?.store ??
          next.stores.find((store) => store.enabled)?.store ??
          null,
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A dream runs for minutes. While one is going, look again every 15 seconds.
  const anyRunning = status?.stores.some((store) => store.running !== null) ?? false;
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

  const updateConfig = async (
    change: Parameters<typeof rubatoMemory.config>[1],
    optimistic: (current: MemoryStatus) => MemoryStatus,
  ) => {
    const previous = status;
    if (previous) setStatus(optimistic(previous));
    try {
      await rubatoMemory.config(environmentId, change);
    } catch (error) {
      setStatus(previous);
      reportError("Could not save the setting", error);
    }
  };

  const runNow = async (store: string) => {
    try {
      await rubatoMemory.dream(environmentId, store);
      toastManager.add({
        type: "info",
        title: `Dream started for ${store}`,
        description: "This can take several minutes. The result appears in the history.",
      });
      setSelectedStore(store);
      await refresh();
    } catch (error) {
      reportError("Could not start the dream", error);
    }
  };

  const visibleStores = useMemo(() => {
    const stores = status?.stores ?? [];
    const rank = (store: MemoryStoreStatus) =>
      (store.pendingRunId !== undefined ? 0 : 4) + (store.enabled ? 0 : 2) + (store.lastDreamAt ? 0 : 1);
    const sorted = stores.toSorted((a, b) => rank(a) - rank(b) || a.store.localeCompare(b.store));
    return showAll ? sorted : sorted.filter(isActive);
  }, [showAll, status]);
  const hiddenCount = (status?.stores.length ?? 0) - (status?.stores.filter(isActive).length ?? 0);
  const ladder = status?.categories.find((entry) => entry.name === status.category);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="memory-dream"
        title="Dreams"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            Refresh
          </Button>
        }
      >
        {loadError ? (
          <SettingsRow title="Could not load memory status" description={loadError} />
        ) : status === null ? (
          <SettingsRow
            title="Loading memory status"
            description="Scanning sessions can take a few seconds."
            control={<Spinner className="size-4" />}
          />
        ) : (
          <>
            <SettingsRow
              title="Model ladder"
              description={
                ladder
                  ? `Tried in order: ${ladder.models.join(" → ")}`
                  : "No models for this category in rubato.jsonc."
              }
              control={
                <Select
                  value={status.category}
                  onValueChange={(next) => {
                    if (typeof next !== "string" || next === status.category) return;
                    void updateConfig({ category: next }, (current) => ({ ...current, category: next }));
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Dream model ladder">
                    <SelectValue>{status.category}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(status.categories.some((entry) => entry.name === status.category)
                      ? status.categories
                      : [{ name: status.category, models: [] }, ...status.categories]
                    ).map((entry) => (
                      <SelectItem key={entry.name} value={entry.name}>
                        {entry.name}
                        {entry.models[0] ? (
                          <span className="ms-2 text-xs text-muted-foreground">
                            {entry.models[0]}
                            {entry.models.length > 1 ? ` +${entry.models.length - 1}` : ""}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Publish"
              description={
                status.publish === "review"
                  ? "Dream edits wait on a branch until you approve them in the history below."
                  : "Dream edits are merged into the store as soon as the dream ends."
              }
              control={
                <Select
                  value={status.publish}
                  onValueChange={(next) => {
                    if (next !== "review" && next !== "auto") return;
                    const publish: DreamPublish = next;
                    void updateConfig({ publish }, (current) => ({ ...current, publish }));
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Dream publish mode">
                    <SelectValue>{status.publish === "review" ? "After review" : "Automatically"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="review">After review</SelectItem>
                    <SelectItem value="auto">Automatically</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          </>
        )}
      </SettingsSection>

      {status ? (
        <SettingsSection id="memory-stores" title="Stores">
          {visibleStores.length === 0 ? (
            <SettingsRow title="No stores in use" description="Show all stores below to turn one on." />
          ) : null}
          {visibleStores.map((store) => (
            <StoreRow
              key={store.store}
              store={store}
              selected={selectedStore === store.store}
              onSelect={() => setSelectedStore(store.store)}
              onToggle={(enabled) =>
                void updateConfig({ store: store.store, enabled }, (current) => ({
                  ...current,
                  stores: current.stores.map((entry) =>
                    entry.store === store.store ? { ...entry, enabled } : entry,
                  ),
                }))
              }
              onRun={() => void runNow(store.store)}
            />
          ))}
          {hiddenCount > 0 ? (
            <div className="px-3 py-2 sm:px-4">
              <Button size="xs" variant="ghost-muted" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Show stores in use" : `Show ${count(hiddenCount, "unused store")}`}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {status && selectedStore ? (
        <DreamHistory
          key={`${selectedStore}:${historySignal}`}
          environmentId={environmentId}
          store={selectedStore}
          pendingRunId={status.stores.find((entry) => entry.store === selectedStore)?.pendingRunId}
          onReviewed={() => void refresh()}
        />
      ) : null}

      <SelfFilesSection environmentId={environmentId} />
    </SettingsPageContainer>
  );
}

function StoreRow({
  store,
  selected,
  onSelect,
  onToggle,
  onRun,
}: {
  store: MemoryStoreStatus;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
}) {
  const last = store.lastGuiRun;
  return (
    <SettingsRow
      className={cn(selected && "bg-accent/40")}
      title={
        <button type="button" className="text-left hover:underline" onClick={onSelect}>
          {store.store}
        </button>
      }
      description={`${store.lastDreamAt ? `Last dream ${ago(store.lastDreamAt)}` : "No dreams yet"} · ${count(store.newSessions, "new session")}`}
      status={
        <span className="flex flex-wrap items-center gap-1.5">
          {store.running ? (
            <Badge variant="info">
              <Spinner className="size-3" />
              Running {store.running.startedAt ? `(started ${ago(store.running.startedAt)})` : ""}
            </Badge>
          ) : null}
          {store.pendingRunId ? (
            <Badge variant="warning" render={<button type="button" onClick={onSelect} />}>
              Needs review
            </Badge>
          ) : null}
          {store.due && !store.running ? <Badge variant="secondary">Due</Badge> : null}
          {!store.running && last && last.status === "failed" ? (
            <span className="text-destructive-foreground" title={last.reason}>
              Last run failed: {(last.reason ?? "").split("\n")[0]}
            </span>
          ) : null}
        </span>
      }
      control={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={store.running !== null}
            onClick={onRun}
            aria-label={`Run ${store.store} now`}
          >
            <PlayIcon className="size-3" />
            Run now
          </Button>
          <Switch
            aria-label={`Dreams for ${store.store}`}
            checked={store.enabled}
            onCheckedChange={(enabled) => onToggle(enabled)}
          />
        </>
      }
    />
  );
}

function DreamHistory({
  environmentId,
  store,
  pendingRunId,
  onReviewed,
}: {
  environmentId: EnvironmentId;
  store: string;
  pendingRunId: string | undefined;
  onReviewed: () => void;
}) {
  const [runs, setRuns] = useState<DreamRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .runs(environmentId, store)
      .then((result) => {
        if (cancelled) return;
        setRuns(result.runs);
        setError(null);
        setOpen((current) => current ?? result.pendingRunId ?? null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store, signal, pendingRunId]);

  return (
    <SettingsSection id="memory-history" title={`Dream history · ${store}`}>
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
                {expanded ? (
                  <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                )}
                {stamp(run.startedAt) || run.runId}
                <Badge variant={label.variant}>{label.label}</Badge>
              </button>
            }
            description={[
              run.model ?? "No model",
              `${count(run.sessions, "session")} read`,
              run.commits > 0 ? count(run.commits, "commit") : null,
              run.reason ?? null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {expanded ? (
              <RunDetail
                environmentId={environmentId}
                store={store}
                runId={run.runId}
                onReviewed={() => {
                  setSignal((value) => value + 1);
                  onReviewed();
                }}
              />
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

function RunDetail({
  environmentId,
  store,
  runId,
  onReviewed,
}: {
  environmentId: EnvironmentId;
  store: string;
  runId: string;
  onReviewed: () => void;
}) {
  const [detail, setDetail] = useState<DreamRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "candidates" | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<"report" | "diff">("report");
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    rubatoMemory
      .run(environmentId, store, runId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, store, runId, signal]);

  const review = async (decision: "approve" | "reject") => {
    const ok = await confirm(
      decision === "approve"
        ? `Merge this dream's changes into ${store}?`
        : "Discard this dream's changes? The sessions it read stay marked as read.",
      decision === "reject",
    );
    if (!ok) return;
    setBusy(decision);
    try {
      await rubatoMemory.review(environmentId, store, decision);
      toastManager.add({
        type: "success",
        title: decision === "approve" ? "Changes merged" : "Changes discarded",
      });
      setSignal((value) => value + 1);
      onReviewed();
    } catch (cause) {
      reportError(decision === "approve" ? "Could not approve" : "Could not reject", cause);
    } finally {
      setBusy(null);
    }
  };

  const addChosen = async () => {
    setBusy("candidates");
    try {
      const result = await rubatoMemory.addCandidates(environmentId, store, runId, [...chosen]);
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

  if (error) return <p className="pb-3 text-sm text-destructive-foreground">{error}</p>;
  if (!detail)
    return (
      <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading
      </div>
    );

  const addable = detail.candidates.filter((candidate) => !candidate.inUser);
  return (
    <div className="space-y-4 pt-1 pb-3">
      {detail.pending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2">
          <span className="me-auto text-sm">This dream is waiting for review.</span>
          <Button size="xs" disabled={busy !== null} onClick={() => void review("approve")}>
            {busy === "approve" ? <Spinner className="size-3" /> : null}
            Approve
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy !== null}
            onClick={() => void review("reject")}
          >
            {busy === "reject" ? <Spinner className="size-3" /> : null}
            Reject
          </Button>
        </div>
      ) : null}

      <div className="flex gap-1">
        <Button size="xs" variant={tab === "report" ? "secondary" : "ghost"} onClick={() => setTab("report")}>
          Report
        </Button>
        <Button size="xs" variant={tab === "diff" ? "secondary" : "ghost"} onClick={() => setTab("diff")}>
          Changes
        </Button>
      </div>
      {tab === "report" ? (
        detail.report ? (
          <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border/60 px-4 py-3">
            <ChatMarkdown text={detail.report} cwd={undefined} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This dream left no report.</p>
        )
      ) : (
        <DiffView diff={detail.diff} note={detail.diffNote} />
      )}

      {detail.sessionList.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{count(detail.sessionList.length, "session")} read</summary>
          <ul className="mt-1 space-y-0.5 ps-4">
            {detail.sessionList.map((session) => (
              <li key={session.id} className="truncate">
                {session.name ?? session.id} {session.cwd ? `· ${session.cwd}` : ""}
                {session.messages !== undefined ? ` · ${count(session.messages, "message")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {detail.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="me-auto text-sm font-medium">User candidates</h4>
            <Button
              size="xs"
              variant="outline"
              disabled={chosen.size === 0 || busy !== null}
              onClick={() => void addChosen()}
            >
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
          {addable.length === 0 ? (
            <p className="text-xs text-muted-foreground">Every candidate is already in user.md.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DiffView({ diff, note }: { diff: string; note: string | null }) {
  if (!diff)
    return (
      <p className="text-sm text-muted-foreground">
        {note && note !== "truncated" ? `Could not read the changes: ${note}` : "No changes."}
      </p>
    );
  return (
    <div className="max-h-[32rem] overflow-auto rounded-lg border border-border/60 bg-muted/30">
      <pre className="min-w-max px-3 py-2 font-mono text-xs leading-5">
        {diff.split("\n").map((line, index) => (
          <div
            // Lines of a diff have no identity beyond their position.
            key={index}
            className={cn(
              line.startsWith("diff --git") && "mt-2 font-semibold text-foreground first:mt-0",
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
        {note === "truncated" ? (
          <div className="mt-2 text-muted-foreground">… Truncated.</div>
        ) : null}
      </pre>
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
        description="Each save is committed to the self memory store."
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
