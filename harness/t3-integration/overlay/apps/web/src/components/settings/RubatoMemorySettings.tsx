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
  merged: { label: "반영됨", variant: "success" },
  pending: { label: "검토 대기", variant: "warning" },
  noop: { label: "바뀐 것 없음", variant: "secondary" },
  failed: { label: "실패", variant: "error" },
  busy: { label: "이미 실행 중", variant: "secondary" },
  trial: { label: "시험", variant: "info" },
};

function runLabel(run: Pick<DreamRunSummary, "status" | "review" | "pending">) {
  if (run.review === "rejected") return { label: "버림", variant: "secondary" as const };
  if (run.status === "pending" && run.review === "merged") return STATUS_LABEL.merged!;
  if (run.status === "pending" && !run.pending) return { label: "검토 끝남", variant: "secondary" as const };
  return STATUS_LABEL[run.status] ?? { label: run.status, variant: "outline" as const };
}

const relativeFormat = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
function ago(iso: string | undefined): string {
  if (!iso) return "없음";
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
  return "방금";
}
function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
      reportError("설정을 저장하지 못했어", error);
    }
  };

  const runNow = async (store: string) => {
    try {
      await rubatoMemory.dream(environmentId, store);
      toastManager.add({
        type: "info",
        title: `${store} 꿈을 시작했어`,
        description: "몇 분에서 수십 분 걸려. 끝나면 기록에 나와.",
      });
      setSelectedStore(store);
      await refresh();
    } catch (error) {
      reportError("꿈을 시작하지 못했어", error);
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
        title="꿈"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label="다시 읽기"
          >
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            다시 읽기
          </Button>
        }
      >
        {loadError ? (
          <SettingsRow title="기억 상태를 읽지 못했어" description={loadError} />
        ) : status === null ? (
          <SettingsRow
            title="기억 상태를 읽는 중"
            description="세션을 훑느라 몇 초 걸려."
            control={<Spinner className="size-4" />}
          />
        ) : (
          <>
            <SettingsRow
              title="모델 사다리"
              description={
                ladder
                  ? `위에서부터 시도해: ${ladder.models.join(" → ")}`
                  : "이 카테고리의 모델을 rubato.jsonc 에서 찾지 못했어."
              }
              control={
                <Select
                  value={status.category}
                  onValueChange={(next) => {
                    if (typeof next !== "string" || next === status.category) return;
                    void updateConfig({ category: next }, (current) => ({ ...current, category: next }));
                  }}
                >
                  <SelectTrigger size="sm" aria-label="꿈 모델 사다리">
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
                            {entry.models.length > 1 ? ` 외 ${entry.models.length - 1}` : ""}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="결과 반영"
              description={
                status.publish === "review"
                  ? "꿈이 고친 내용은 브랜치에서 기다리고, 아래 기록에서 승인해야 저장소에 들어가."
                  : "꿈이 끝나면 고친 내용이 바로 저장소에 들어가."
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
                  <SelectTrigger size="sm" aria-label="꿈 결과 반영 방식">
                    <SelectValue>{status.publish === "review" ? "검토 후" : "바로"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="review">검토 후</SelectItem>
                    <SelectItem value="auto">바로</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          </>
        )}
      </SettingsSection>

      {status ? (
        <SettingsSection id="memory-stores" title="저장소">
          {visibleStores.length === 0 ? (
            <SettingsRow title="쓰는 저장소가 없어" description="아래에서 전체를 펼쳐 켤 수 있어." />
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
                {showAll ? "쓰는 저장소만 보기" : `꺼져 있고 꿈을 꾼 적 없는 저장소 ${hiddenCount}개 더 보기`}
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
      description={`마지막 꿈 ${ago(store.lastDreamAt)} · 새 세션 ${store.newSessions}개`}
      status={
        <span className="flex flex-wrap items-center gap-1.5">
          {store.running ? (
            <Badge variant="info">
              <Spinner className="size-3" />
              실행 중 {store.running.startedAt ? `(${ago(store.running.startedAt)} 시작)` : ""}
            </Badge>
          ) : null}
          {store.pendingRunId ? (
            <Badge variant="warning" render={<button type="button" onClick={onSelect} />}>
              검토 대기
            </Badge>
          ) : null}
          {store.due && !store.running ? <Badge variant="secondary">오늘 꿀 차례</Badge> : null}
          {!store.running && last && last.status === "failed" ? (
            <span className="text-destructive-foreground" title={last.reason}>
              지난번 실행 실패: {(last.reason ?? "").split("\n")[0]}
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
            aria-label={`${store.store} 지금 실행`}
          >
            <PlayIcon className="size-3" />
            지금 실행
          </Button>
          <Switch
            aria-label={`${store.store} 꿈 켜기`}
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
    <SettingsSection id="memory-history" title={`꿈 기록 · ${store}`}>
      {error ? <SettingsRow title="기록을 읽지 못했어" description={error} /> : null}
      {runs === null && !error ? (
        <SettingsRow title="기록을 읽는 중" control={<Spinner className="size-4" />} />
      ) : null}
      {runs?.length === 0 ? <SettingsRow title="아직 꿈을 꾼 적이 없어" /> : null}
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
              run.model ?? "모델 없음",
              `세션 ${run.sessions}개 읽음`,
              run.commits > 0 ? `커밋 ${run.commits}개` : null,
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
        ? `${store} 에 이 꿈의 변경을 합칠까?`
        : `이 꿈의 변경을 버릴까? 꿈이 읽은 세션은 읽은 것으로 남아.`,
      decision === "reject",
    );
    if (!ok) return;
    setBusy(decision);
    try {
      await rubatoMemory.review(environmentId, store, decision);
      toastManager.add({
        type: "success",
        title: decision === "approve" ? "저장소에 합쳤어" : "꿈의 변경을 버렸어",
      });
      setSignal((value) => value + 1);
      onReviewed();
    } catch (cause) {
      reportError(decision === "approve" ? "승인하지 못했어" : "버리지 못했어", cause);
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
        title: result.added > 0 ? `user.md 에 ${result.added}줄 넣었어` : "이미 다 들어 있어",
      });
      setChosen(new Set());
      setSignal((value) => value + 1);
      window.dispatchEvent(new CustomEvent("rubato-memory-self-changed"));
    } catch (cause) {
      reportError("user.md 에 넣지 못했어", cause);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="pb-3 text-sm text-destructive-foreground">{error}</p>;
  if (!detail)
    return (
      <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> 읽는 중
      </div>
    );

  const addable = detail.candidates.filter((candidate) => !candidate.inUser);
  return (
    <div className="space-y-4 pt-1 pb-3">
      {detail.pending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2">
          <span className="me-auto text-sm">이 꿈은 검토를 기다리고 있어.</span>
          <Button size="xs" disabled={busy !== null} onClick={() => void review("approve")}>
            {busy === "approve" ? <Spinner className="size-3" /> : null}
            승인
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy !== null}
            onClick={() => void review("reject")}
          >
            {busy === "reject" ? <Spinner className="size-3" /> : null}
            버리기
          </Button>
        </div>
      ) : null}

      <div className="flex gap-1">
        <Button size="xs" variant={tab === "report" ? "secondary" : "ghost"} onClick={() => setTab("report")}>
          보고서
        </Button>
        <Button size="xs" variant={tab === "diff" ? "secondary" : "ghost"} onClick={() => setTab("diff")}>
          바뀐 내용
        </Button>
      </div>
      {tab === "report" ? (
        detail.report ? (
          <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border/60 px-4 py-3">
            <ChatMarkdown text={detail.report} cwd={undefined} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">이 꿈은 보고서를 남기지 않았어.</p>
        )
      ) : (
        <DiffView diff={detail.diff} note={detail.diffNote} />
      )}

      {detail.sessionList.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">읽은 세션 {detail.sessionList.length}개</summary>
          <ul className="mt-1 space-y-0.5 ps-4">
            {detail.sessionList.map((session) => (
              <li key={session.id} className="truncate">
                {session.name ?? session.id} {session.cwd ? `· ${session.cwd}` : ""}
                {session.messages !== undefined ? ` · 메시지 ${session.messages}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {detail.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="me-auto text-sm font-medium">나에 대한 후보</h4>
            <Button
              size="xs"
              variant="outline"
              disabled={chosen.size === 0 || busy !== null}
              onClick={() => void addChosen()}
            >
              {busy === "candidates" ? <Spinner className="size-3" /> : null}
              고른 {chosen.size}줄 user.md 에 넣기
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
                  {candidate.inUser ? " (이미 있음)" : ""}
                </span>
              </li>
            ))}
          </ul>
          {addable.length === 0 ? (
            <p className="text-xs text-muted-foreground">후보가 모두 user.md 에 들어 있어.</p>
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
        {note && note !== "truncated" ? `바뀐 내용을 읽지 못했어: ${note}` : "바뀐 내용이 없어."}
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
          <div className="mt-2 text-muted-foreground">… 너무 길어서 여기까지만 보여줘.</div>
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
        title: result.commit ? `${file} 저장하고 커밋했어` : `${file} 는 바뀐 게 없어`,
      });
      const content = drafts[file].length === 0 || drafts[file].endsWith("\n") ? drafts[file] : `${drafts[file]}\n`;
      setSaved((current) => (current ? { ...current, [file]: content } : current));
      setDrafts((current) => (current ? { ...current, [file]: content } : current));
    } catch (cause) {
      reportError(`${file} 를 저장하지 못했어`, cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      id="memory-self"
      title="나에 대해"
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
        title={file === "user.md" ? "user.md — 내가 어떤 사람인지" : "soul.md — 에이전트가 어떤 태도로 일하는지"}
        description="저장할 때마다 기억 self 저장소에 커밋으로 남아."
      >
        {error ? <p className="pb-3 text-sm text-destructive-foreground">{error}</p> : null}
        {drafts === null && !error ? (
          <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground">
            <Spinner className="size-3.5" /> 읽는 중
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
              placeholder={file === "user.md" ? "- 한국어 반말로 말한다" : "- 결론부터 말한다"}
            />
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                className="flex-1"
                value={summary}
                onChange={(event) => setSummary(event.currentTarget.value)}
                placeholder="커밋 메시지 (비우면 바뀐 줄 수로 적어)"
                aria-label="커밋 메시지"
              />
              <Button
                size="xs"
                variant="ghost"
                disabled={!dirty || saving}
                onClick={() =>
                  setDrafts((current) => (current && saved ? { ...current, [file]: saved[file] } : current))
                }
              >
                되돌리기
              </Button>
              <Button size="xs" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <Spinner className="size-3" /> : null}
                저장
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
