import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { UI_LANGUAGE_STORAGE_KEY, uiText } from "../../rubatoI18n";
import {
  rubatoMemory,
  type UserMemoryAsk,
  type UserMemoryChange,
  type UserMemoryItem,
  type UserMemoryView,
} from "../../state/rubatoMemory";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  changeWord,
  evidenceSource,
  FAILURE_TEXTS,
  failureText,
  itemBasis,
  justChanged,
  overviewLine,
  pollDelay,
  presetRequest,
  problemTexts,
  threadAsks,
  topicTitle,
  workingAsk,
} from "./RubatoUserMemory.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Settings > Memory > About you. What Rubato remembers about the person, read as a short summary by
// topic, and a conversation with a model about it: ask why, correct, narrow, forget, or tell it
// something new. Every answer shows what actually changed in the memory, read back from the store.
// Text written by the user or a model is marked translate="no" so the Korean interface leaves it alone.

type EnvironmentId = Parameters<typeof rubatoMemory.userView>[0];
type Focus = { readonly path: string; readonly text: string };

// Relative times are written in the interface language here; the dictionary cannot template every unit.
const relativeFormat = new Intl.RelativeTimeFormat(
  typeof window !== "undefined" && window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) === "ko" ? "ko" : "en",
  { numeric: "auto" },
);
function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - Date.now()) / 1000);
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}


export function UserMemoryPanel({
  environmentId,
  highlight,
}: {
  environmentId: EnvironmentId;
  /** A remembered line to bring into view (a search result opened from the overview). */
  highlight: string | null;
}) {
  const [view, setView] = useState<UserMemoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [focus, setFocus] = useState<Focus | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Requests sent from this page: their outcome shows in place, on the line they were about.
  const [sentHere, setSentHere] = useState<ReadonlySet<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setView(await rubatoMemory.userView(environmentId));
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a request is handled (or a dream updates the memory), look again until it ends.
  const delay = pollDelay(view);
  useEffect(() => {
    if (delay === null) return;
    const timer = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(timer);
  }, [delay, view, load]);

  const working = view ? workingAsk(view.asks) : null;
  const busy = sending || working !== null;

  const send = async (request: string, about: Focus | null, { fromComposer }: { fromComposer: boolean }): Promise<boolean> => {
    const trimmed = request.trim();
    if (trimmed === "" || busy) return false;
    setSending(true);
    setSendError(null);
    try {
      const started = await rubatoMemory.userAsk(environmentId, trimmed, about);
      setSentHere((current) => new Set([...current, started.id]));
      if (fromComposer) {
        setText("");
        setFocus(null);
      }
      await load();
      return true;
    } catch (cause) {
      // The words stay where they were typed; nothing was sent.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fromComposer) setSendError(message);
      else toastManager.add({ type: "error", title: "Could not send the request", description: message });
      return false;
    } finally {
      setSending(false);
    }
  };

  const editAgain = (ask: UserMemoryAsk) => {
    setText(ask.text);
    setFocus(ask.focus ? { path: ask.focus.path, text: ask.focus.text ?? ask.focus.path } : null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  useEffect(() => {
    if (!highlight || !view) return;
    const row = document.querySelector(`[data-memory-path="${CSS.escape(highlight)}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [highlight, view]);

  if (view === null) {
    return (
      <SettingsSection id="memory-you" title="What Rubato remembers about you">
        {loadError ? (
          <SettingsRow
            title="Could not load what Rubato remembers"
            description={loadError}
            control={
              <Button size="xs" variant="outline" onClick={() => void load()}>
                <RefreshCwIcon className="size-3" />
                Try again
              </Button>
            }
          />
        ) : (
          <SettingsRow title="Loading what Rubato remembers" control={<Spinner className="size-4" />} />
        )}
      </SettingsSection>
    );
  }

  const changed = justChanged(view.asks);
  const paths = new Set(view.topics.flatMap((topic) => topic.items.map((item) => item.path)));
  // A request sent here about one line answers on that line; a forgotten line stays as a crossed-out
  // row until the page is left, so the result is seen where it happened.
  const inlineAsk = (path: string) => view.asks.find((ask) => sentHere.has(ask.id) && ask.focus?.path === path) ?? null;
  const forgottenHere = view.asks.filter((ask) => sentHere.has(ask.id) && ask.state === "done" && ask.focus && !paths.has(ask.focus.path));
  const shownInline = new Set(view.asks.filter((ask) => sentHere.has(ask.id) && ask.focus !== null).map((ask) => ask.id));
  const topicIds = [...new Set([...view.topics.map((topic) => topic.id), ...forgottenHere.map((ask) => topicOf(ask.focus!.path))])];
  return (
    <>
      <SettingsSection id="memory-you" title="What Rubato remembers about you">
        <SettingsRow
          title={overviewLine(view)}
          description={
            view.count === 0
              ? "As you work, the daily dream notes lasting things about you, like how you like answers and how you decide, and keeps them here. You can also tell Rubato directly below."
              : "Agents look these up when a question needs them. None of it is added to every conversation."
          }
          status={<DreamState view={view} />}
        />
        {view.legacyProfile === "waiting" ? (
          <SettingsRow
            title="Your old user.md will move in here"
            description="The next dream turns it into the lines below. The file itself stays as it is, and it is no longer added to every conversation."
          />
        ) : null}
        <SettingsRow title="Ask or tell Rubato" description="Ask about anything it remembers, or say something new to remember. To change one line, use the buttons next to it.">
          <Composer
            textareaRef={composerRef}
            text={text}
            focus={focus}
            busy={busy}
            sending={sending}
            working={working !== null}
            error={sendError}
            onText={(value) => {
              setText(value);
              if (sendError) setSendError(null);
            }}
            onClearFocus={() => setFocus(null)}
            onSend={() => void send(text, focus, { fromComposer: true })}
          />
          <AskThread
            {...threadAsks(view.asks, sentHere, shownInline, Date.now())}
            busy={busy}
            onRetry={(ask) =>
              void send(ask.text, ask.focus ? { path: ask.focus.path, text: ask.focus.text ?? "" } : null, { fromComposer: false })
            }
            onEdit={editAgain}
          />
        </SettingsRow>
      </SettingsSection>

      {topicIds.map((id) => {
        const topic = view.topics.find((entry) => entry.id === id) ?? { id, title: null, items: [] };
        return (
          <SettingsSection key={id} id={`memory-you-${id || "other"}`} title={topicTitle(topic)}>
            {topic.items.map((item) => (
              <RememberedItem
                key={item.path}
                item={item}
                changed={changed.get(item.path) ?? null}
                ask={inlineAsk(item.path)}
                highlighted={highlight === item.path}
                busy={busy}
                onSend={(request) => send(request, { path: item.path, text: item.text }, { fromComposer: false })}
                onEdit={editAgain}
              />
            ))}
            {forgottenHere
              .filter((ask) => topicOf(ask.focus!.path) === id)
              .map((ask) => (
                <ForgottenRow key={ask.id} ask={ask} />
              ))}
          </SettingsSection>
        );
      })}
    </>
  );
}

function topicOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
}

/** A line forgotten from this page, kept in place as crossed out so the result is visible where it was. */
function ForgottenRow({ ask }: { ask: UserMemoryAsk }) {
  const before = ask.result?.changes.find((change) => change.path === ask.focus?.path)?.before ?? ask.focus?.text ?? "";
  return (
    <SettingsRow
      className="bg-muted/30"
      title={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span translate="no" className="font-normal text-muted-foreground line-through">
            {before}
          </span>
          <Badge variant="secondary">Forgotten</Badge>
        </span>
      }
      description={
        <span className="flex items-center gap-1">
          <CheckIcon className="size-3" />
          Removed from memory and search.
          {ask.result?.reply ? <span translate="no"> {ask.result.reply}</span> : null}
        </span>
      }
    />
  );
}

function DreamState({ view }: { view: UserMemoryView }) {
  if (view.dream.running)
    return (
      <Badge variant="info">
        <Spinner className="size-3" />
        Updating from recent conversations
      </Badge>
    );
  if (!view.updatedAt && view.dream.waiting === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-2">
      {view.updatedAt ? <span>{`Updated ${ago(view.updatedAt)}`}</span> : null}
      {view.dream.waiting > 0 ? <span>New notes are added on the next dream</span> : null}
    </span>
  );
}

function Composer({
  textareaRef,
  text,
  focus,
  busy,
  sending,
  working,
  error,
  onText,
  onClearFocus,
  onSend,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  focus: Focus | null;
  busy: boolean;
  sending: boolean;
  working: boolean;
  error: string | null;
  onText: (value: string) => void;
  onClearFocus: () => void;
  onSend: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSend();
    }
    if (event.key === "Escape" && focus) onClearFocus();
  };
  return (
    <form
      className="space-y-2 pt-2 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      {focus ? (
        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/8 px-2.5 py-1.5 text-xs">
          <span className="shrink-0 font-medium text-info-foreground">Asking about</span>
          <span translate="no" className="min-w-0 flex-1 text-foreground">
            {focus.text}
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Stop asking about this line"
            onClick={onClearFocus}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
      <Textarea
        ref={textareaRef}
        aria-label={uiText("Ask or tell Rubato about what it remembers")}
        value={text}
        rows={3}
        onChange={(event) => onText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        // The page translation leaves textareas alone, attributes included; these come translated from here.
        placeholder={uiText(
          focus
            ? "What should it say instead? Or ask why it remembers this."
            : "e.g. Why do you think I prefer short answers? / That's not true anymore. / Remember that I review on my phone.",
        )}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {working ? "Wait for the request below to finish." : "⌘/Ctrl Enter to send"}
        </span>
        <Button type="submit" size="xs" disabled={busy || text.trim() === ""}>
          {sending ? <Spinner className="size-3" /> : <SendIcon className="size-3" />}
          Send
        </Button>
      </div>
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive-foreground">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          Not sent: {error}
        </p>
      ) : null}
    </form>
  );
}

function AskThread({
  current,
  earlier,
  busy,
  onRetry,
  onEdit,
}: {
  current: readonly UserMemoryAsk[];
  earlier: readonly UserMemoryAsk[];
  busy: boolean;
  onRetry: (ask: UserMemoryAsk) => void;
  onEdit: (ask: UserMemoryAsk) => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  if (current.length === 0 && earlier.length === 0) return null;
  const shown = showEarlier ? [...current, ...earlier] : current;
  return (
    <div className="space-y-2 pb-3">
      {shown.length > 0 ? (
        <ol className="space-y-2" aria-label="Your requests">
          {shown.map((ask) => (
            <AskCard key={ask.id} ask={ask} busy={busy} onRetry={() => onRetry(ask)} onEdit={() => onEdit(ask)} />
          ))}
        </ol>
      ) : null}
      {earlier.length > 0 ? (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
          {showEarlier ? "Hide earlier requests" : `Earlier requests (${earlier.length})`}
        </button>
      ) : null}
    </div>
  );
}

function AskCard({ ask, busy, compact = false, onRetry, onEdit }: { ask: UserMemoryAsk; busy: boolean; compact?: boolean; onRetry: () => void; onEdit: () => void }) {
  const result = ask.result;
  return (
    <li className="rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 text-sm" data-ask-state={ask.state}>
      <div className="flex flex-col items-end gap-1">
        <p translate="no" className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-accent px-2.5 py-1.5">
          {ask.text}
        </p>
        {ask.focus?.text && !compact ? (
          <p className="max-w-[90%] text-right text-xs text-muted-foreground">{`About “${ask.focus.text}”`}</p>
        ) : null}
      </div>
      <div className="mt-2" aria-live="polite">
        {ask.state === "working" ? (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" />
            Rubato is looking at your memory. This usually takes under a minute.
          </p>
        ) : ask.state === "done" && result ? (
          <div className="space-y-2">
            {result.reply ? (
              <p translate="no" className="whitespace-pre-wrap">
                {result.reply}
              </p>
            ) : null}
            {problemTexts(ask).map((text) => (
              <p key={text} className="flex items-start gap-1.5 text-xs text-warning-foreground">
                <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                {text}
              </p>
            ))}
            {result.changes.length > 0 ? (
              <ChangeList changes={result.changes} />
            ) : (result.problems ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing in your memory changed.</p>
            ) : null}
            {result.changes.length > 0 ? (
              <p className="flex items-center gap-1 text-xs text-success-foreground">
                <CheckIcon className="size-3" />
                <span>{`Saved ${ago(result.finishedAt)}. Agents' search uses it from now on.`}</span>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-destructive-foreground">
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span>Nothing was changed.</span> <FailureReason ask={ask} />
              </span>
            </p>
            <div className="flex gap-1">
              <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
                <RefreshCwIcon className="size-3" />
                Try again
              </Button>
              <Button size="xs" variant="ghost" onClick={onEdit}>
                <PencilIcon className="size-3" />
                Edit request
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** Known reasons are interface text; anything else came from the runner or a provider and stays as it is. */
function FailureReason({ ask }: { ask: UserMemoryAsk }) {
  const text = failureText(ask);
  return FAILURE_TEXTS.has(text) ? <span>{text}</span> : <span translate="no">{text}</span>;
}

function ChangeList({ changes }: { changes: readonly UserMemoryChange[] }) {
  return (
    <ul className="space-y-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-2" aria-label="What changed">
      {changes.map((change) => (
        <li key={`${change.change}:${change.path}`} className="text-xs">
          <Badge
            variant={change.change === "deleted" ? "secondary" : change.change === "added" ? "success" : "info"}
            className="me-1.5"
          >
            {changeWord(change)}
          </Badge>
          {change.before && change.change !== "added" ? (
            <span translate="no" className={cn(change.after ? "text-muted-foreground line-through" : "line-through")}>
              {change.before}
            </span>
          ) : null}
          {change.before && change.after && change.change !== "added" ? (
            <ArrowRightIcon className="mx-1 inline size-3 text-muted-foreground" aria-hidden />
          ) : null}
          {change.after ? <span translate="no">{change.after}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function RememberedItem({
  item,
  changed,
  ask,
  highlighted,
  busy,
  onSend,
  onEdit,
}: {
  item: UserMemoryItem;
  changed: UserMemoryChange | null;
  /** The newest request sent from this page about this line, shown under it. */
  ask: UserMemoryAsk | null;
  highlighted: boolean;
  busy: boolean;
  onSend: (request: string) => Promise<boolean>;
  onEdit: (ask: UserMemoryAsk) => void;
}) {
  const [why, setWhy] = useState(false);
  const [mode, setMode] = useState<"idle" | "correct" | "forget">("idle");
  const [draft, setDraft] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const basis = itemBasis(item);

  useEffect(() => {
    if (mode === "correct") editorRef.current?.focus();
  }, [mode]);

  const submit = async (request: string) => {
    if (await onSend(request)) {
      setMode("idle");
      setDraft("");
    }
  };

  return (
    <SettingsRow
      data-memory-path={item.path}
      className={cn(highlighted && "bg-info/8", changed && ask?.state !== "working" && "bg-success/6")}
      title={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span translate="no" className="font-normal">
            {item.text}
          </span>
          {changed && ask?.state !== "working" ? <Badge variant="success">Just changed</Badge> : null}
        </span>
      }
      description={basis ?? undefined}
      control={
        <span className="flex flex-wrap justify-end gap-0.5">
          <Button size="xs" variant="ghost" aria-expanded={why} onClick={() => setWhy(!why)}>
            <MessageCircleQuestionIcon className="size-3" />
            Why?
          </Button>
          <Button size="xs" variant="ghost" aria-expanded={mode === "correct"} disabled={busy} onClick={() => setMode(mode === "correct" ? "idle" : "correct")}>
            <PencilIcon className="size-3" />
            Correct
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode("forget")}>
            <Trash2Icon className="size-3" />
            Forget
          </Button>
        </span>
      }
    >
      {why ? (
        <div className="space-y-2 pb-3">
          {item.evidence.length === 0 ? (
            <p className="text-xs text-muted-foreground">No words of yours were kept for this one.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Why Rubato remembers this">
              {item.evidence.map((entry) => (
                <li key={entry.raw} className="border-s-2 border-border ps-2.5 text-xs">
                  <span className="text-muted-foreground">
                    <span>{evidenceSource(entry)}</span>
                    {entry.date ? <span translate="no">{` · ${entry.date}`}</span> : null}
                  </span>
                  {entry.quote ? (
                    <q translate="no" className="mt-0.5 block text-sm text-foreground">
                      {entry.quote}
                    </q>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {item.scope.length > 0 ? (
            <p className="text-xs text-muted-foreground">{`Only applies: ${item.scope.join("; ")}`}</p>
          ) : null}
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void submit(presetRequest("why"))}>
            <MessageCircleQuestionIcon className="size-3" />
            Ask Rubato to explain
          </Button>
        </div>
      ) : null}
      {mode === "correct" ? (
        <form
          className="space-y-2 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(draft);
          }}
        >
          <Textarea
            ref={editorRef}
            aria-label={uiText("What should it remember instead?")}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit(draft);
              }
              if (event.key === "Escape") setMode("idle");
            }}
            placeholder={uiText("What is true instead, or when it applies. e.g. Only for code reviews; for design talks I want detail.")}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={busy || draft.trim() === ""}>
              <SendIcon className="size-3" />
              Send correction
            </Button>
          </div>
        </form>
      ) : null}
      {mode === "forget" ? (
        <div role="group" aria-label="Confirm forgetting" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/6 px-2.5 py-2 text-xs">
          <span className="min-w-0 flex-1">Forget this? Rubato removes it and will not learn it again from old conversations.</span>
          <Button size="xs" variant="destructive" disabled={busy} onClick={() => void submit(presetRequest("forget"))}>
            Forget
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMode("idle")}>
            Keep
          </Button>
        </div>
      ) : null}
      {ask ? (
        <ol className="pb-3">
          <AskCard ask={ask} busy={busy} compact onRetry={() => void onSend(ask.text)} onEdit={() => onEdit(ask)} />
        </ol>
      ) : null}
    </SettingsRow>
  );
}

/** The personality setting: the one thing about how agents work with the user that every conversation carries. */
export function PersonalitySection({ environmentId }: { environmentId: EnvironmentId }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    rubatoMemory.self(environmentId).then(
      (result) => {
        if (cancelled) return;
        setSaved(result.soul);
        setDraft((current) => current ?? result.soul);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const dirty = saved !== null && draft !== null && draft !== saved;
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      const result = await rubatoMemory.saveSoul(environmentId, draft);
      const content = draft === "" || draft.endsWith("\n") ? draft : `${draft}\n`;
      setSaved(content);
      setDraft(content);
      toastManager.add({ type: "success", title: result.commit ? "Saved. New conversations use it." : "No changes to save" });
    } catch (cause) {
      toastManager.add({ type: "error", title: "Could not save", description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection id="memory-self" title="How agents work with you">
      <SettingsRow
        title="Personality"
        description="Added to every new conversation, exactly as you write it. Rubato never changes it on its own."
      >
        {error ? <p className="pb-3 text-sm text-destructive-foreground">{error}</p> : null}
        {draft === null && !error ? (
          <div className="flex items-center gap-2 pb-3 text-sm text-muted-foreground">
            <Spinner className="size-3.5" /> Loading
          </div>
        ) : null}
        {draft !== null ? (
          <div className="space-y-2 pt-2 pb-3">
            <Textarea
              aria-label={uiText("Personality")}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              rows={6}
              placeholder="- Lead with the conclusion"
            />
            <div className="flex items-center justify-end gap-2">
              <Button size="xs" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
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
