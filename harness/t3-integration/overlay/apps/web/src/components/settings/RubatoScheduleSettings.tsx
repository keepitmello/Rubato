import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { readLocalApi } from "../../localApi";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { RubatoRequestError } from "../../state/rubatoHttp";
import {
  rubatoSchedule,
  type ScheduledTask,
  type ScheduleKind,
  type SchedulePreview,
  type ScheduleRun,
  type TaskList,
} from "../../state/rubatoSchedule";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { cn } from "../../lib/utils";
import { iconForProviderModel } from "../chat/providerIconUtils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  COPY,
  EVERY_HOURS,
  STATUS_BADGE,
  WEEK,
  durationLabel,
  emptyForm,
  formFieldOf,
  formFromTask,
  inputFromForm,
  reasonLabel,
  runActions,
  runTimeLabel,
  scheduleFromForm,
  statusLabel,
  tildePath,
  validateForm,
  type FormErrors,
  type TaskForm,
} from "./RubatoScheduleSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

/** Tasks change behind the page (the session tool, the CLI, the scheduler): look this often. */
const POLL_MS = 3_000;
/** Next-run labels are relative ("Today at…"); refresh them at least this often. */
const RELABEL_MS = 60_000;

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

async function confirm(message: string): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: "destructive" });
  return answer ? await answer : window.confirm(message);
}

/** The primary environment's id once its HTTP connection is ready; null until then. */
function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

interface RubatoModel {
  readonly slug: string;
  readonly name: string;
  readonly reasoning: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/** The Rubato instance's catalogue: the models T3 lists for Rubato, with their reasoning levels. */
function useRubatoModels(): readonly RubatoModel[] {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () =>
      (providers.find((provider) => provider.driver === "rubato-pi")?.models ?? []).map((model) => {
        const descriptor = model.capabilities?.optionDescriptors?.find(
          (entry) => entry.id === "reasoningEffort" && entry.type === "select",
        );
        return {
          slug: model.slug,
          name: model.name,
          reasoning: descriptor && descriptor.type === "select" ? descriptor.options : [],
        };
      }),
    [providers],
  );
}

function ModelIcon({ slug }: { slug: string }) {
  const Icon = iconForProviderModel("rubato-pi" as never, { slug });
  return Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null;
}

type View = { readonly mode: "list" } | { readonly mode: "form"; readonly task: ScheduledTask | null };

export function RubatoScheduleSettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [list, setList] = useState<TaskList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>({ mode: "list" });
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumps whenever the store changes, so an open run history reloads too.
  const [signal, setSignal] = useState(0);
  const revision = useRef<number | null>(null);
  const models = useRubatoModels();

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoSchedule.list(environmentId);
      revision.current = next.revision;
      setList(next);
      setLoadError(null);
      setSignal((value) => value + 1);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [environmentId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A cheap revision read; the list is fetched again only when something changed.
  useEffect(() => {
    if (environmentId === null) return;
    let lastFull = Date.now();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void rubatoSchedule.revision(environmentId).then(
        (next) => {
          if (next.revision !== revision.current || Date.now() - lastFull > RELABEL_MS) {
            lastFull = Date.now();
            void load();
          }
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, load]);

  const replaceTask = (task: ScheduledTask) =>
    setList((current) =>
      current ? { ...current, tasks: current.tasks.map((entry) => (entry.id === task.id ? task : entry)) } : current,
    );

  const setEnabled = async (task: ScheduledTask, enabled: boolean) => {
    replaceTask({ ...task, enabled });
    try {
      replaceTask(await rubatoSchedule.setEnabled(environmentId, task.id, enabled));
    } catch (error) {
      replaceTask(task);
      reportError(COPY.toggleFailed, error);
    }
  };

  const runNow = async (task: ScheduledTask, fromRunId?: string) => {
    try {
      await rubatoSchedule.runNow(environmentId, task.id, fromRunId);
      toastManager.add({ type: "info", title: COPY.started(task.name), description: COPY.startedBody });
      setExpanded(task.id);
      void load();
    } catch (error) {
      reportError(COPY.runFailed, error);
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (!(await confirm(COPY.deleteConfirm(task.name)))) return;
    try {
      await rubatoSchedule.remove(environmentId, task.id);
      toastManager.add({ type: "success", title: COPY.deleted(task.name) });
      void load();
    } catch (error) {
      reportError(COPY.deleteFailed, error);
    }
  };

  if (view.mode === "form") {
    return (
      <SettingsPageContainer>
        <TaskFormView
          environmentId={environmentId}
          task={view.task}
          models={models}
          home={list?.home ?? null}
          onDone={(saved) => {
            setView({ mode: "list" });
            if (saved) setExpanded(saved.id);
            void load();
          }}
        />
      </SettingsPageContainer>
    );
  }

  const tasks = list?.tasks ?? null;
  const home = list?.home ?? null;
  const nameOf = (slug: string | null) =>
    slug === null ? COPY.fields.defaultModel : (models.find((model) => model.slug === slug)?.name ?? slug);

  return (
    <SettingsPageContainer>
      {list && !list.scheduler.running ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{COPY.schedulerOff}</AlertTitle>
          <AlertDescription>{COPY.schedulerOffBody}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection
        id="scheduled-tasks"
        title={COPY.sectionTasks}
        headerAction={
          <span className="flex items-center gap-1">
            <Button size="xs" variant="ghost" disabled={loading} onClick={() => void refresh()}>
              {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
              {COPY.refresh}
            </Button>
            {tasks && tasks.length > 0 ? (
              <Button size="xs" variant="outline" onClick={() => setView({ mode: "form", task: null })}>
                <PlusIcon className="size-3.5" />
                {COPY.newTask}
              </Button>
            ) : null}
          </span>
        }
      >
        {loadError ? <SettingsRow title={COPY.loadFailed} description={loadError} /> : null}
        {tasks === null && !loadError ? (
          <SettingsRow title={COPY.loading} control={<Spinner className="size-4" />} />
        ) : null}
        {tasks?.length === 0 ? <EmptyState onCreate={() => setView({ mode: "form", task: null })} /> : null}
        {tasks?.map((task) => (
          <TaskRow
            key={task.id}
            environmentId={environmentId}
            task={task}
            home={home}
            modelName={nameOf(task.model)}
            expanded={expanded === task.id}
            signal={signal}
            onToggleExpanded={() => setExpanded((current) => (current === task.id ? null : task.id))}
            onEnabled={(enabled) => void setEnabled(task, enabled)}
            onEdit={() => setView({ mode: "form", task })}
            onRunNow={(fromRunId) => void runNow(task, fromRunId)}
            onDelete={() => void remove(task)}
            modelNameOf={nameOf}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-5 sm:px-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CalendarClockIcon className="size-4 text-muted-foreground" />
        {COPY.emptyTitle}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">{COPY.emptyBody}</p>
      <p className="max-w-prose text-xs text-muted-foreground">{COPY.emptyHint}</p>
      <Button size="sm" onClick={onCreate}>
        <PlusIcon className="size-3.5" />
        {COPY.newTask}
      </Button>
    </div>
  );
}

function LastRunBadge({ run, now }: { run: ScheduleRun; now: Date }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={STATUS_BADGE[run.status]}>
        {run.status === "running" ? <Spinner className="size-3" /> : null}
        {statusLabel(run)}
      </Badge>
      <span>{runTimeLabel(run, now)}</span>
    </span>
  );
}

function TaskRow({
  environmentId,
  task,
  home,
  modelName,
  expanded,
  signal,
  onToggleExpanded,
  onEnabled,
  onEdit,
  onRunNow,
  onDelete,
  modelNameOf,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  home: string | null;
  modelName: string;
  expanded: boolean;
  signal: number;
  onToggleExpanded: () => void;
  onEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onRunNow: (fromRunId?: string) => void;
  onDelete: () => void;
  modelNameOf: (slug: string | null) => string;
}) {
  const now = new Date(useRelativeTimeTick(30_000));
  const stop = { onClick: (event: MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
   };
  return (
    <SettingsRow
      className={cn("cursor-pointer hover:bg-accent/30", !task.enabled && "[&_h3]:text-muted-foreground")}
      onClick={onToggleExpanded}
      title={
        <span className="inline-flex items-center gap-1.5">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          )}
          {task.name}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span>{task.summary}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            {task.model ? <ModelIcon slug={task.model} /> : null}
            {modelName}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">
            {tildePath(task.cwd, home)}
          </span>
        </span>
      }
      status={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {task.lastRun ? <LastRunBadge run={task.lastRun} now={now} /> : <span>{COPY.never}</span>}
          <span>
            {COPY.nextRun}:{" "}
            {!task.enabled ? COPY.off : (task.nextRunLabel ?? COPY.noNextRun)}
          </span>
        </span>
      }
      control={
        <span className="flex items-center gap-1.5" {...stop}>
          <Switch
            aria-label={COPY.enabledLabel(task.name)}
            checked={task.enabled}
            onCheckedChange={(enabled) => onEnabled(enabled)}
          />
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label={COPY.taskOptions(task.name)} />}
            >
              <MoreVerticalIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-40">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                {COPY.menu.edit}
              </MenuItem>
              <MenuItem disabled={task.running} onClick={() => onRunNow()}>
                <PlayIcon />
                {COPY.menu.runNow}
              </MenuItem>
              <MenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon />
                {COPY.menu.delete}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      }
    >
      {expanded ? (
        <div className="mt-3 cursor-default" {...stop}>
          <RunHistory
            environmentId={environmentId}
            task={task}
            signal={signal}
            modelNameOf={modelNameOf}
            onRerun={(run) => onRunNow(run.id)}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function RunHistory({
  environmentId,
  task,
  signal,
  modelNameOf,
  onRerun,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  signal: number;
  modelNameOf: (slug: string | null) => string;
  onRerun: (run: ScheduleRun) => void;
}) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useRelativeTimeTick(1_000);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    rubatoSchedule.runs(environmentId, task.id).then(
      (next) => {
        if (cancelled) return;
        setRuns(next.runs);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, task.id, signal]);

  const openThread = async (run: ScheduleRun) => {
    if (!run.sessionId || environmentId === null) return;
    try {
      const { threadId } = await rubatoSchedule.thread(environmentId, run.sessionId, run.serverId);
      if (!threadId) {
        toastManager.add({ type: "info", title: COPY.threadPending });
        return;
      }
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } catch (cause) {
      reportError(COPY.threadFailed, cause);
    }
  };

  const now = new Date(nowMs);
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{COPY.history}</div>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      {runs === null && !error ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> {COPY.historyLoading}
        </p>
      ) : null}
      {runs?.length === 0 ? <p className="text-xs text-muted-foreground">{COPY.historyEmpty}</p> : null}
      {runs && runs.length > 0 ? (
        <ol className="divide-y divide-border/50 rounded-lg border border-border/60 bg-background/40">
          {runs.map((run) => {
            const actions = runActions(run);
            const reason = reasonLabel(run);
            const duration = durationLabel(run, nowMs);
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                <Badge variant={STATUS_BADGE[run.status]} className="shrink-0">
                  {run.status === "running" ? <Spinner className="size-3" /> : null}
                  {statusLabel(run)}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground/90">
                    {run.trigger === "manual" ? `${COPY.manual} · ` : ""}
                    {runTimeLabel(run, now)}
                  </span>
                  {duration ? <span className="text-muted-foreground"> · {duration}</span> : null}
                  {run.status !== "skipped" && (run.model || task.model) ? (
                    <span className="text-muted-foreground"> · {modelNameOf(run.model ?? task.model)}</span>
                  ) : null}
                  {reason ? (
                    <span
                      className={cn(
                        "line-clamp-3 block whitespace-pre-line",
                        run.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
                      )}
                    >
                      {reason}
                      {run.detail ? `: ${run.detail}` : ""}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {actions.openThread ? (
                    <Button size="xs" variant="ghost" onClick={() => void openThread(run)}>
                      <MessageSquareIcon className="size-3" />
                      {COPY.openThread}
                    </Button>
                  ) : null}
                  {actions.rerun ? (
                    <Button size="xs" variant="outline" disabled={task.running} onClick={() => onRerun(run)}>
                      {actions.rerun === "retry" ? (
                        <RotateCcwIcon className="size-3" />
                      ) : (
                        <PlayIcon className="size-3" />
                      )}
                      {actions.rerun === "retry" ? COPY.retry : COPY.runNow}
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

const OTHER_FOLDER = "__other__";
const DEFAULT = "__default__";
const KINDS: readonly ScheduleKind[] = ["daily", "weekdays", "weekly", "interval", "once"];

function FieldError({ message }: { message: string | undefined }) {
  return message ? <p className="mt-1.5 text-xs text-destructive-foreground">{message}</p> : null;
}

function TaskFormView({
  environmentId,
  task,
  models,
  home,
  onDone,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask | null;
  models: readonly RubatoModel[];
  home: string | null;
  onDone: (saved: ScheduledTask | null) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<TaskForm>(() =>
    task ? formFromTask(task, new Date()) : emptyForm(new Date()),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const set = (patch: Partial<TaskForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof FormErrors];
      if ("kind" in patch || "everyHours" in patch || "windowOn" in patch) delete next.schedule;
      if ("windowStart" in patch || "windowEnd" in patch) delete next.window;
      return next;
    });
  };

  // Projects the app already shows, one per folder.
  const allProjects = useProjects();
  const projects = useMemo(() => {
    const seen = new Set<string>();
    return allProjects.filter((project) => {
      if (project.environmentId !== environmentId || seen.has(project.workspaceRoot)) return false;
      seen.add(project.workspaceRoot);
      return true;
    });
  }, [allProjects, environmentId]);
  const [otherFolder, setOtherFolder] = useState(
    () => form.cwd !== "" && !projects.some((project) => project.workspaceRoot === form.cwd),
  );

  // The schedule sentence and next run come from the store's own functions.
  const schedule = scheduleFromForm(form);
  const scheduleKey = JSON.stringify(schedule);
  useEffect(() => {
    if (!schedule || environmentId === null) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      rubatoSchedule.preview(environmentId, schedule).then(
        (next) => {
          if (cancelled) return;
          setPreview(next);
          setPreviewError(null);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // scheduleKey stands for schedule's contents.
  }, [scheduleKey, environmentId]);

  const model = models.find((entry) => entry.slug === form.model) ?? null;

  const pickFolder = async () => {
    const picked = await readLocalApi()?.dialogs.pickFolder(form.cwd ? { initialPath: form.cwd } : undefined);
    if (picked) {
      set({ cwd: picked });
      setOtherFolder(!projects.some((project) => project.workspaceRoot === picked));
    }
  };

  const save = async () => {
    const found = validateForm(form);
    const input = inputFromForm(form);
    if (!input) {
      setErrors(found);
      return;
    }
    setSaving(true);
    try {
      const saved = task
        ? await rubatoSchedule.update(environmentId, task.id, input)
        : await rubatoSchedule.create(environmentId, input);
      onDone(saved);
    } catch (cause) {
      const field = cause instanceof RubatoRequestError ? formFieldOf(cause.field) : null;
      if (field) setErrors({ [field]: cause instanceof Error ? cause.message : String(cause) });
      else reportError(COPY.saveFailed, cause);
    } finally {
      setSaving(false);
    }
  };

  const timeInput = (label: string, value: string, onChange: (value: string) => void, invalid?: boolean) => (
    <Input
      nativeInput
      type="time"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="h-8 w-32"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );

  let scheduleInputs: ReactNode = null;
  switch (form.kind) {
    case "daily":
    case "weekdays":
      scheduleInputs = (
        <Labeled label={COPY.fields.time}>{timeInput(COPY.fields.time, form.time, (time) => set({ time }), Boolean(errors.time))}</Labeled>
      );
      break;
    case "weekly":
      scheduleInputs = (
        <>
          <Labeled label={COPY.fields.days}>
            <ToggleGroup
              aria-label={COPY.fields.days}
              variant="segmented"
              multiple
              value={[...form.days]}
              onValueChange={(next) =>
                set({ days: WEEK.map((entry) => entry.day).filter((day) => (next as string[]).includes(day)) })
              }
            >
              {WEEK.map((entry) => (
                <Toggle key={entry.day} value={entry.day} className="min-w-11">
                  {entry.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </Labeled>
          <Labeled label={COPY.fields.time}>{timeInput(COPY.fields.time, form.time, (time) => set({ time }), Boolean(errors.time))}</Labeled>
        </>
      );
      break;
    case "interval":
      scheduleInputs = (
        <>
          <Labeled label={COPY.fields.every}>
            <Select
              value={String(form.everyHours)}
              onValueChange={(next) => {
                if (typeof next === "string") set({ everyHours: Number(next) });
              }}
            >
              <SelectTrigger size="sm" className="w-32" aria-label={COPY.fields.every}>
                <SelectValue>{COPY.fields.hours(form.everyHours)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {EVERY_HOURS.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {COPY.fields.hours(hours)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Labeled>
          <Labeled label={COPY.fields.window}>
            <span className="flex flex-wrap items-center gap-2">
              <Switch
                aria-label={COPY.fields.window}
                checked={form.windowOn}
                onCheckedChange={(windowOn) => set({ windowOn })}
              />
              {form.windowOn ? (
                <>
                  {timeInput(`${COPY.fields.window} start`, form.windowStart, (windowStart) => set({ windowStart }), Boolean(errors.window))}
                  <span className="text-xs text-muted-foreground">{COPY.fields.windowTo}</span>
                  {timeInput(`${COPY.fields.window} end`, form.windowEnd, (windowEnd) => set({ windowEnd }), Boolean(errors.window))}
                </>
              ) : null}
            </span>
          </Labeled>
        </>
      );
      break;
    case "once":
      scheduleInputs = (
        <>
          <Labeled label={COPY.fields.date}>
            <Input
              nativeInput
              type="date"
              aria-label={COPY.fields.date}
              aria-invalid={Boolean(errors.date) || undefined}
              className="h-8 w-40"
              value={form.date}
              onChange={(event) => set({ date: event.target.value })}
            />
          </Labeled>
          <Labeled label={COPY.fields.time}>{timeInput(COPY.fields.time, form.time, (time) => set({ time }), Boolean(errors.time))}</Labeled>
        </>
      );
      break;
  }

  const scheduleError = errors.schedule ?? errors.days ?? errors.time ?? errors.date ?? errors.window;

  return (
    <>
      <div>
        <Button size="xs" variant="ghost" onClick={() => onDone(null)}>
          <ChevronLeftIcon className="size-3.5" />
          {COPY.back}
        </Button>
      </div>
      <SettingsSection id="scheduled-task-form" title={task ? COPY.editTitle : COPY.createTitle}>
        <SettingsRow title={<label htmlFor={`${id}-name`}>{COPY.fields.name}</label>}>
          <Input
            id={`${id}-name`}
            className="mt-2"
            placeholder={COPY.fields.namePlaceholder}
            maxLength={80}
            value={form.name}
            aria-invalid={Boolean(errors.name) || undefined}
            onChange={(event) => set({ name: event.target.value })}
          />
          <FieldError message={errors.name} />
        </SettingsRow>

        <SettingsRow title={COPY.fields.project} description={COPY.fields.projectHint}>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {projects.length > 0 ? (
              <Select
                value={otherFolder ? OTHER_FOLDER : form.cwd || null}
                onValueChange={(next) => {
                  if (typeof next !== "string") return;
                  if (next === OTHER_FOLDER) {
                    setOtherFolder(true);
                    return;
                  }
                  setOtherFolder(false);
                  set({ cwd: next });
                }}
              >
                <SelectTrigger size="sm" className="min-w-56" aria-label={COPY.fields.project}>
                  <SelectValue>
                    {otherFolder
                      ? COPY.fields.otherFolder
                      : (projects.find((project) => project.workspaceRoot === form.cwd)?.title ??
                        (form.cwd ? tildePath(form.cwd, home) : (
                          <span className="text-muted-foreground">{COPY.fields.chooseProject}</span>
                        )))}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {projects.map((project) => (
                    <SelectItem key={project.workspaceRoot} value={project.workspaceRoot}>
                      <span className="flex flex-col">
                        <span>{project.title}</span>
                        <span className="text-xs text-muted-foreground">{tildePath(project.workspaceRoot, home)}</span>
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_FOLDER}>{COPY.fields.otherFolder}</SelectItem>
                </SelectPopup>
              </Select>
            ) : null}
            {otherFolder || projects.length === 0 ? (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Input
                  className="min-w-56 flex-1 font-mono text-xs"
                  placeholder={COPY.fields.folderPlaceholder}
                  aria-label={COPY.fields.project}
                  aria-invalid={Boolean(errors.cwd) || undefined}
                  value={form.cwd}
                  onChange={(event) => set({ cwd: event.target.value })}
                />
                {window.desktopBridge ? (
                  <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
                    <FolderOpenIcon className="size-3.5" />
                    {COPY.fields.browse}
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
          <FieldError message={errors.cwd} />
        </SettingsRow>

        <SettingsRow title={<label htmlFor={`${id}-prompt`}>{COPY.fields.prompt}</label>} description={COPY.fields.promptHint}>
          <Textarea
            id={`${id}-prompt`}
            className="mt-2 min-h-24"
            placeholder={COPY.fields.promptPlaceholder}
            value={form.prompt}
            aria-invalid={Boolean(errors.prompt) || undefined}
            onChange={(event) => set({ prompt: event.target.value })}
          />
          <FieldError message={errors.prompt} />
        </SettingsRow>

        <SettingsRow title={COPY.fields.model} description={COPY.fields.modelHint}>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              value={form.model ?? DEFAULT}
              onValueChange={(next) => {
                if (typeof next !== "string") return;
                const slug = next === DEFAULT ? null : next;
                const levels = models.find((entry) => entry.slug === slug)?.reasoning ?? [];
                set({ model: slug, thinking: levels.some((level) => level.id === form.thinking) ? form.thinking : null });
              }}
            >
              <SelectTrigger size="sm" className="min-w-56" aria-label={COPY.fields.model}>
                <SelectValue>
                  <span className="inline-flex items-center gap-2">
                    {form.model ? <ModelIcon slug={form.model} /> : null}
                    {form.model ? (model?.name ?? form.model) : COPY.fields.defaultModel}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT}>{COPY.fields.defaultModel}</SelectItem>
                {models.map((entry) => (
                  <SelectItem key={entry.slug} value={entry.slug}>
                    <span className="inline-flex items-center gap-2">
                      <ModelIcon slug={entry.slug} />
                      {entry.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {model && model.reasoning.length > 0 ? (
              <Select
                value={form.thinking ?? DEFAULT}
                onValueChange={(next) => {
                  if (typeof next === "string") set({ thinking: next === DEFAULT ? null : next });
                }}
              >
                <SelectTrigger size="sm" className="w-56" aria-label={COPY.fields.thinking}>
                  <SelectValue>
                    {COPY.fields.thinking}:{" "}
                    {model.reasoning.find((level) => level.id === form.thinking)?.label ?? COPY.fields.defaultThinking}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={DEFAULT}>{COPY.fields.defaultThinking}</SelectItem>
                  {model.reasoning.map((level) => (
                    <SelectItem key={level.id} value={level.id}>
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
          <FieldError message={errors.model ?? errors.thinking} />
        </SettingsRow>

        <SettingsRow title={COPY.fields.schedule}>
          <div className="mt-2 space-y-3">
            <ToggleGroup
              aria-label={COPY.fields.schedule}
              variant="segmented"
              value={[form.kind]}
              onValueChange={(next) => {
                const kind = KINDS.find((entry) => entry === next[0]);
                if (kind) set({ kind });
              }}
            >
              {KINDS.map((kind) => (
                <Toggle key={kind} value={kind}>
                  {COPY.kinds[kind]}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="space-y-2.5">{scheduleInputs}</div>
            <FieldError message={scheduleError} />
            <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm">
              {preview ? (
                <>
                  <div>{preview.summary}</div>
                  <div className="text-xs text-muted-foreground">
                    {COPY.nextRun}: {preview.nextRunLabel ?? COPY.noNextRun}
                  </div>
                </>
              ) : previewError ? (
                <div className="text-xs text-destructive-foreground">{previewError}</div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {COPY.nextRun}: {schedule ? "…" : COPY.noNextRun}
                </div>
              )}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
      <div className="flex justify-end gap-2 px-3 sm:px-4">
        <Button variant="ghost" onClick={() => onDone(null)}>
          {COPY.cancel}
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner className="size-3.5" /> : null}
          {task ? COPY.save : COPY.create}
        </Button>
      </div>
    </>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
