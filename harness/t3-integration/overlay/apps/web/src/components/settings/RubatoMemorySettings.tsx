// Pieces of the memory page that other pages reuse or that predate its views: the ready
// environment, asking about a store in chat, one dream run's changes, a diff, a file viewer and
// editor, and the dream's model ladder (Settings › Agents › Titles and summaries edits its own with it).
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
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
  type MemoryStoreStatus,
  type MemoryStoreSummary,
} from "../../state/rubatoMemory";
import ChatMarkdown from "../ChatMarkdown";
import { iconForProviderModel } from "../chat/rubatoModelIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { addedContent, chatPrompt, projectForStore, type BadgeVariant } from "./RubatoMemorySettings.logic";
import { SettingsRow } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/** The primary environment's id once its HTTP connection is ready; null until then. */
export function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

/** A store from its directory, plus what the dream CLI knows once that answers. */
export type StoreView = MemoryStoreSummary & {
  readonly lastDreamAt?: string;
  readonly newSessions?: number;
  readonly due?: boolean;
  readonly lastGuiRun?: MemoryStoreStatus["lastGuiRun"];
};

export function tildePath(value: string, home: string | null): string {
  return home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
}

type AskAbout = Parameters<typeof chatPrompt>[1];

/** Opens a new thread in the memory's project with where it is in the composer; the user picks a model and asks. */
export function useAskInChat(environmentId: EnvironmentId, store: StoreView, home: string | null) {
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
export function RunView({
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


export function DiffView({ diff }: { diff: string }) {
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

export function FileViewer({
  environmentId,
  store,
  path,
  onAsk,
  onSaved,
  withoutHeading = false,
}: {
  environmentId: EnvironmentId;
  store: string;
  path: string;
  onAsk: () => void;
  onSaved: () => void;
  /** The page already shows the file's question above it: leave its first `# ` heading out of the body. */
  withoutHeading?: boolean;
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
  const stripped = path.endsWith(".md") ? content.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : null;
  const body = stripped !== null && withoutHeading ? stripped.replace(/^\s*#\s+.*\r?\n/, "") : stripped;
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
  title = "Models",
  description = "The dream tries these in order and uses the first one that answers.",
  subject = "the dream",
}: {
  models: readonly DreamModel[];
  onChange: (next: readonly DreamModel[]) => void;
  title?: string;
  description?: ReactNode;
  /** What the ladder runs, for the labels: "the dream", "titles". */
  subject?: string;
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
    <SettingsRow title={title} description={description}>
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
              title={models.length === 1 ? `${subject[0]!.toUpperCase()}${subject.slice(1)} needs at least one model` : undefined}
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
            <SelectTrigger size="sm" aria-label={`Add a model to ${subject}`}>
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
