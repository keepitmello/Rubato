// Settings › Companion (intent companion-manage; mockup ~/.rubato/scratch/companion-ux/mock.html).
// Talking is the way to change a companion; this page is its view and fallback.
//
//   ┌ My companions ┐ ┌ profile: picture (camera menu) · name · what it calls you · since · on · Talk ┐
//   │ face name     │ │ ┌ Who it is ───────────┐ ┌ What it knows about me ┐                          │
//   │ line          │ │ │ rows · Change by talking (primary) · Full text                         │
//   │ + New         │ │ ┌ Life ────────────────┐ ┌ Connections ───────────┐                          │
//   └───────────────┘ │ ▸ Advanced: every prompt piece, tools, resident memory, Rubato's defaults       │
//
// The list always shows, even with one companion; "New companion" makes one (create) and opens its
// room once its first conversation is in the app. "Change by talking" opens the room with a short
// draft naming the card; the companion answers with a proposal card there, and only Apply saves.
// Advanced keeps every piece editor the page had: a saved piece reaches the companion when its
// conversation next crosses a compaction or a new window (prompt-rules role-prompt.mjs); the tools
// piece follows the product and only reads here.
//
// The Telegram part reads and writes the same files the engine's resident messenger reads
// (harness/companion/messenger/store.mjs): a request is a file, and the answer shows up here a
// second or two later, so it polls while the page is open. While the product runs no Telegram
// (store.mjs TELEGRAM_ENABLED) the server answers no status and those rows do not show; the
// Telegram row itself shows only for a profile that has Telegram.
import { ChevronRightIcon, MessageCircleIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { companionModelAccounts, companionGeminiStart } from "@t3tools/shared/rubatoCompanionModelChoice";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../../state/server";

import { cn } from "../../lib/utils";
import { subscribeUiLanguage, uiLanguage } from "../../rubatoI18n";
import {
  acceptCompanionStatus,
  createCompanion,
  rubatoCompanion,
  selectCompanion,
  useReadyEnvironmentId,
  useRubatoCompanion,
  useUiText,
  waitForCompanionRoom,
  type CallEffort,
  type CompanionChoice,
  type CompanionPiece,
  type CompanionPieceId,
  type CompanionDreamModel,
  type CompanionSettingsPatch,
  type CompanionSummaries,
  type DocsCadence,
  type DocsRoot,
  type TelegramHeldMessage,
  type TelegramStatus,
} from "../../state/rubatoCompanion";
import {
  companionDraft,
  companionLine,
  companionListLine,
  sinceLine,
  type CompanionDraft,
} from "../../state/rubatoCompanionModel";
import { RubatoCompanionFace, useOpenCompanionRoom } from "../chat/RubatoCompanionFace";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DreamModelsEditor } from "./RubatoMemorySettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { RubatoCompanionPicture } from "./RubatoCompanionPicture";
import { RubatoCompanionIconSetting } from "./RubatoCompanionIconSetting";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

const CALL_EFFORT_LABELS: Record<CallEffort, string> = {
  conversation: "Same as chat",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const DOCS_CADENCE_LABELS: Record<DocsCadence, string> = {
  off: "Off",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

const DOCS_MODE_LABELS: Record<DocsRoot["mode"], string> = {
  edit: "edits directly",
  branch: "review branch",
  report: "reads only",
};

/** The summary cards' row names (contract `summaries` keys); the text in them is the companion's. */
const WHO_ROWS: Record<string, string> = { line: "In a line", nature: "Nature", speech: "Speech", bond: "Between us" };
const ME_ROWS: Record<string, string> = { work: "What I do", now: "Right now", talk: "How to talk to me", trust: "Trusted with" };

/** The interface language, following a switch. */
function useLanguage(): "en" | "ko" {
  return useSyncExternalStore(subscribeUiLanguage, uiLanguage, uiLanguage) === "ko" ? "ko" : "en";
}


interface DiffRow {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** The lines Rubato removed and added, in order; unchanged lines are left out of the compare view. */
function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  // Longest common subsequence, in one flat table (row-major), so the walk picks removed and added
  // lines in the order they read. Unchanged lines are not part of what this view shows.
  const width = B.length + 1;
  const table = new Array<number>((A.length + 1) * width).fill(0);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        (A[i] ?? "") === (B[j] ?? "") ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const lineA = A[i] ?? "";
    const lineB = B[j] ?? "";
    if (lineA === lineB) {
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      rows.push({ kind: "removed", text: lineA });
      i += 1;
    } else {
      rows.push({ kind: "added", text: lineB });
      j += 1;
    }
  }
  while (i < A.length) rows.push({ kind: "removed", text: A[i++] ?? "" });
  while (j < B.length) rows.push({ kind: "added", text: B[j++] ?? "" });
  return rows;
}

/** Rubato's changes base → new, and the person's copy beside the new default. Nothing merges here. */
function PieceCompare({ piece }: { piece: CompanionPiece }) {
  const changes = piece.baseText === undefined ? [] : lineDiff(piece.baseText, piece.defaultText);
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">What Rubato changed</span>
        {piece.baseUnknown ? (
          <p className="text-xs text-muted-foreground">
            Rubato has no record of the default this copy came from, so only your version and the current
            default are compared.
          </p>
        ) : changes.length === 0 ? (
          <p className="text-xs text-muted-foreground">Rubato&apos;s default has not changed since this copy.</p>
        ) : (
          <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">
            {changes.map((row, index) => (
              <div key={`${row.kind}-${index}`} className={row.kind === "added" ? "text-emerald-600" : "text-rose-600"}>
                {row.kind === "added" ? "+ " : "− "}
                {row.text}
              </div>
            ))}
          </pre>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Mine</span>
          <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">
            {piece.personalText ?? ""}
          </pre>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">New default</span>
          <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">
            {piece.defaultText}
          </pre>
        </div>
      </div>
    </div>
  );
}

function PieceEditor({
  piece,
  busy,
  initiallyOpen = false,
  onSave,
}: {
  piece: CompanionPiece;
  busy: boolean;
  /** "Full text" on a summary card opens its piece here. */
  initiallyOpen?: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  const current = piece.personalText ?? piece.defaultText;
  const [open, setOpen] = useState(initiallyOpen);
  // The parent keys this editor by the saved text, so a save starts a fresh draft.
  const [draft, setDraft] = useState(current);
  const changed = draft.trim() !== current.trim();
  return (
    <SettingsRow
      id={`rubato-companion-piece-${piece.id}`}
      title={piece.title}
      description={piece.description}
      status={
        <span className="flex items-center gap-1">
          {piece.defaultChanged ? <Badge variant="warning">Default update available</Badge> : null}
          {piece.personalText !== undefined ? <Badge variant="outline">Yours</Badge> : null}
        </span>
      }
      control={
        <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : piece.editable ? "Edit" : "View"}
        </Button>
      }
    >
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {piece.personalText !== undefined && (piece.defaultChanged === true || piece.baseUnknown === true) ? (
            <PieceCompare piece={piece} />
          ) : null}
          <Textarea
            className="min-h-48"
            value={draft}
            readOnly={!piece.editable}
            aria-label={piece.title}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {piece.editable ? (
            <div className="flex justify-end gap-2">
              {piece.personalText !== undefined ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onSave("")}>
                  <RotateCcwIcon className="size-3.5" />
                  Back to default
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !changed}
                onClick={() => setDraft(current)}
              >
                Discard
              </Button>
              <Button size="sm" disabled={busy || !changed} onClick={() => void onSave(draft)}>
                {busy ? <Spinner className="size-3.5" /> : null}
                Save
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}



// ── The list ──────────────────────────────────────────────────────────────────────────────────

function CompanionList({ companions, selectedId }: { companions: readonly CompanionChoice[]; selectedId: string }) {
  const environmentId = useReadyEnvironmentId();
  const openRoom = useOpenCompanionRoom();
  const [creating, setCreating] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const accounts = companionModelAccounts(providers ?? [], settings?.providerInstances);
  const account = accounts.find(item => item.instanceId === accountId);
  const create = async () => {
    if (environmentId === null || creating) return;
    setCreating(true);
    try {
      const id = await createCompanion(environmentId, account && model ? { instanceId: account.instanceId, model } : null);
      setChoosing(false);
      const threadId = await waitForCompanionRoom(environmentId, id);
      if (threadId !== null) await openRoom(threadId);
      else
        toastManager.add({
          type: "info",
          title: "It is still waking up",
          description: "It shows in the list now; its room opens from Talk once it is awake.",
        });
    } catch (cause) {
      reportError("Could not make a new companion", cause);
    }
    setCreating(false);
  };
  return (
    <nav
      aria-label="My companions"
      data-rubato-companion-list=""
      className="flex w-56 shrink-0 flex-col gap-1 self-start rounded-2xl border border-border bg-card p-2.5 text-card-foreground"
    >
      <div className="px-2 pt-1 pb-1.5 text-muted-foreground text-xs">My companions</div>
      {companions.map((item) => {
        const line = companionListLine(item);
        return (
          <button
            key={item.id}
            type="button"
            data-rubato-companion-item={item.id}
            aria-current={item.id === selectedId ? "true" : undefined}
            onClick={() => selectCompanion(item.id)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              item.id === selectedId ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <RubatoCompanionFace companion={item} className="size-9 text-sm" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold text-sm">{item.title}</span>
              <span className="truncate text-muted-foreground text-xs">
                {line.map((part, index) => (
                  <span key={part}>
                    {index > 0 ? " · " : null}
                    <span>{part}</span>
                  </span>
                ))}
              </span>
            </span>
          </button>
        );
      })}
      <button
        type="button"
        data-rubato-companion-new=""
        disabled={creating || environmentId === null}
        onClick={() => accounts.length ? setChoosing(!choosing) : void create()}
        className={cn(
          "mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-2 py-2.5 font-medium text-primary text-sm",
          "hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70",
        )}
      >
        {creating ? <Spinner className="size-3.5" /> : <PlusIcon aria-hidden="true" className="size-4" />}
        <span>{creating ? "Waking it up…" : "New companion"}</span>
      </button>
      {choosing && accounts.length > 0 ? (
        <div className="flex flex-col gap-2 px-2 py-1">
          <label className="text-xs">Provider
            <select className="w-full rounded border bg-background p-1" value={accountId}
              onChange={event => {
                const value = event.target.value;
                const start = value === "gemini" ? companionGeminiStart(accounts) : null;
                const next = accounts.find(item => item.instanceId === (start?.instanceId ?? value));
                setAccountId(next?.instanceId ?? "");
                setModel(next?.defaultModel ?? "");
              }}>
              <option value="">Rubato default</option>
              {!accountId ? <option value="gemini">Gemini</option> : null}
              {accounts.map(item => <option key={item.instanceId} value={item.instanceId}>Gemini · {item.label}</option>)}
            </select>
          </label>
          {account ? <label className="text-xs">Model
            <select className="w-full rounded border bg-background p-1" value={model}
              onChange={event => setModel(event.target.value)}>
              <option value="">Select a model</option>
              {account.models.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
            </select>
          </label> : null}
          <Button size="sm" disabled={creating || (Boolean(accountId) && !account?.models.some(item => item.slug === model))}
            onClick={() => void create()}>Create companion</Button>
        </div>
      ) : null}
    </nav>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────────────────────

function Card({ id, title, children, className }: { id?: string; title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("flex min-w-0 flex-col rounded-2xl border border-border bg-card px-4 py-3.5 text-card-foreground", className)}>
      <h3 className="mb-1.5 font-semibold text-[0.95rem]">{title}</h3>
      {children}
    </section>
  );
}

function CardRow({ id, title, description, control }: { id?: string; title: ReactNode; description?: ReactNode; control?: ReactNode }) {
  return (
    <div id={id} className="flex items-center justify-between gap-3 border-border border-t py-2 first-of-type:border-t-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{title}</span>
        {description ? <span className="text-muted-foreground text-xs">{description}</span> : null}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}

/**
 * This companion's own dream ladder (companion.mjs dream.models), with Settings › Memory's editor.
 * Empty means the user's dream models for all of Rubato, then Rubato's own; the companion can set
 * the same list in conversation.
 */
function CompanionDreamModels({
  models,
  busy,
  save,
}: {
  models: readonly CompanionDreamModel[];
  busy: boolean;
  save: (patch: CompanionSettingsPatch) => Promise<boolean>;
}) {
  const store = (next: readonly { readonly model: string; readonly reasoning: CompanionDreamModel["reasoning"] | null }[]) =>
    save({ dream: { models: next.map(({ model, reasoning }) => (reasoning ? { model, reasoning } : { model })) } });
  return (
    <div data-rubato-companion-dream-models="">
      <DreamModelsEditor
        models={models.map(({ model, reasoning }) => ({ model, reasoning: reasoning ?? null }))}
        onChange={(next) => void store(next)}
        title="Dream models"
        subject="its dream"
        description={
          models.length === 0
            ? "Uses the dream models in Settings › Memory. Add one to give this companion its own."
            : "Its memory dream and document upkeep try these in order and use the first one that answers."
        }
      />
      {models.length > 0 ? (
        <div className="flex justify-end pb-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void store([])}>
            Use the models in Settings › Memory
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The dream's document upkeep (harness/companion/dream/docs.mjs): how often, and the places it
 * tends. The companion usually sets these in conversation; the page shows them and can change them,
 * through the same validation (companion.mjs writeSettings).
 */
function DocsUpkeep({
  docs,
  busy,
  save,
}: {
  docs: { readonly cadence: DocsCadence; readonly roots: readonly DocsRoot[] };
  busy: boolean;
  save: (patch: CompanionSettingsPatch) => Promise<boolean>;
}) {
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<DocsRoot["mode"]>("branch");
  const saveRoots = (roots: readonly DocsRoot[]) => save({ dream: { docs: { roots } } });
  const modeSelect = (value: DocsRoot["mode"], onChange: (next: DocsRoot["mode"]) => void, label: string) => (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next as DocsRoot["mode"]);
      }}
    >
      <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={label} disabled={busy}>
        <SelectValue>{DOCS_MODE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {(Object.keys(DOCS_MODE_LABELS) as DocsRoot["mode"][]).map((item) => (
          <SelectItem key={item} value={item}>
            {DOCS_MODE_LABELS[item]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
  return (
    <>
      <CardRow
        id="rubato-companion-docs"
        title="Tidying documents"
        description={docs.roots.length === 0 ? "Nothing to tend yet. Tell it which folders to keep tidy." : "After its memory, its dream keeps these tidy"}
        control={
          <Select
            value={docs.cadence}
            onValueChange={(next) => {
              if (typeof next === "string") void save({ dream: { docs: { cadence: next as DocsCadence } } });
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="How often documents are tidied" disabled={busy}>
              <SelectValue>{DOCS_CADENCE_LABELS[docs.cadence]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(DOCS_CADENCE_LABELS) as DocsCadence[]).map((cadence) => (
                <SelectItem key={cadence} value={cadence}>
                  {DOCS_CADENCE_LABELS[cadence]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {docs.roots.map((root, index) => (
        <div key={root.path} data-rubato-companion-docs-root="" className="flex items-center gap-2 pb-2">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs" translate="no" title={root.path}>
            {root.path}
          </span>
          {modeSelect(root.mode, (next) => void saveRoots(docs.roots.map((item, at) => (at === index ? { ...item, mode: next } : item))), "How it is tended")}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void saveRoots(docs.roots.filter((_, at) => at !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2 pb-2">
        <Input
          aria-label="Folder or file to tend"
          className="h-8 flex-1"
          placeholder="~/Github-repos/project/docs"
          value={path}
          disabled={busy}
          onChange={(event) => setPath(event.target.value)}
        />
        {modeSelect(mode, setMode, "How the new place is tended")}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || path.trim() === ""}
          onClick={() => {
            void saveRoots([...docs.roots, { path: path.trim(), mode }]).then((kept) => {
              if (kept) setPath("");
            });
          }}
        >
          Add
        </Button>
      </div>
    </>
  );
}

/** "Who it is" or "What it knows about me", in the companion's own words. */
function SummaryCard({
  id,
  title,
  card,
  labels,
  loaded,
  waitingText,
  onTalk,
  onSumUp,
  onFullText,
  canTalk,
}: {
  id: string;
  title: string;
  card: CompanionSummaries["who"] | undefined;
  labels: Record<string, string>;
  loaded: boolean;
  waitingText: string;
  onTalk: () => void;
  onSumUp: () => void;
  onFullText: () => void;
  canTalk: boolean;
}) {
  return (
    <Card id={id} title={<span translate="no">{title}</span>}>
      {!loaded ? (
        <div className="py-3">
          <Spinner className="size-4" />
        </div>
      ) : card && card.rows.length > 0 ? (
        <dl className="flex flex-col">
          {card.rows.map((row) => (
            <div key={row.key} className="flex gap-3 border-border border-t py-1.5 text-sm first:border-t-0">
              <dt className="w-20 shrink-0 text-muted-foreground">{labels[row.key] ?? row.key}</dt>
              <dd className="min-w-0 flex-1" translate="no">
                {row.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="py-1.5 text-muted-foreground text-sm">{waitingText}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {loaded && !card ? (
          <Button size="sm" disabled={!canTalk} onClick={onSumUp}>
            <MessageCircleIcon aria-hidden="true" className="size-3.5" />
            Ask it to sum up
          </Button>
        ) : (
          <Button size="sm" disabled={!canTalk} onClick={onTalk}>
            <MessageCircleIcon aria-hidden="true" className="size-3.5" />
            Change by talking
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onFullText}>
          Full text
        </Button>
      </div>
    </Card>
  );
}

/** The two cards' text; read once per visit and again every half minute while the page shows. */
function useSummaries(environmentId: EnvironmentId | null, companionId: string) {
  const [summaries, setSummaries] = useState<CompanionSummaries | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (environmentId === null) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await rubatoCompanion.summaries(environmentId, companionId);
        if (alive) setSummaries(next);
      } catch {
        // A server without summaries shows the cards as not written yet.
      }
      if (alive) setLoaded(true);
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [environmentId, companionId]);
  return { summaries, loaded };
}

// ── Connections ───────────────────────────────────────────────────────────────────────────────

const HELD_KIND = (message: TelegramHeldMessage): string =>
  message.target?.name ?? message.target?.chatId ?? "you";

/** The messenger's state for this companion, polled while the page is open; null while the product runs none. */
function useTelegram(environmentId: EnvironmentId | null) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const apply = useCallback((next: { telegram: TelegramStatus }) => {
    setTelegram(next.telegram);
    setError(null);
  }, []);
  useEffect(() => {
    if (environmentId === null) return;
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await rubatoCompanion.telegram(environmentId);
        if (!alive) return;
        if (next.telegram === null) {
          setOff(true);
          window.clearInterval(timer);
          return;
        }
        apply({ telegram: next.telegram });
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [environmentId, apply]);
  const run = async (work: () => Promise<{ telegram: TelegramStatus }>) => {
    setBusy(true);
    try {
      apply(await work());
    } catch (cause) {
      reportError("Could not change the Telegram connection", cause);
    }
    setBusy(false);
  };
  return { telegram, busy, error, off, run };
}

function TelegramDetails({
  environmentId,
  title,
  botName,
  telegram,
  busy,
  run,
}: {
  environmentId: EnvironmentId | null;
  /** The name as the page shows it. */
  title: string;
  /** The companion's own name, which its new bot takes. */
  botName: string;
  telegram: TelegramStatus;
  busy: boolean;
  run: (work: () => Promise<{ telegram: TelegramStatus }>) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const made = telegram.bot.token != null;
  const paired = telegram.pairing.status === "paired";
  const waiting = telegram.pairing.status === "pending";
  return (
    <div data-rubato-companion-telegram="" className="mt-1 mb-2 flex flex-col rounded-xl border border-border px-3 py-1">
      <CardRow
        id="rubato-companion-telegram-enabled"
        title="Telegram"
        description={`Talk to ${title} from your own Telegram chat. Anything ${title} writes to someone else waits here for you.`}
        control={
          <Switch
            aria-label="Telegram"
            checked={telegram.settings.enabled}
            disabled={busy}
            onCheckedChange={(next) => void run(() => rubatoCompanion.saveTelegramSettings(environmentId, { enabled: next }))}
          />
        }
      />
      {!made ? (
        <>
          <CardRow
            id="rubato-companion-telegram-token"
            title="Paste the token @BotFather gave you"
            description="In Telegram, open @BotFather, send /newbot, answer its two questions, and paste the token it sends back here."
          />
          <div className="flex items-center gap-2 pb-2">
            <Input
              aria-label="Telegram bot token"
              className="h-8 flex-1"
              placeholder="123456789:AA…"
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button size="sm" disabled={busy || token.trim() === ""}
              onClick={() => void run(() => rubatoCompanion.setTelegramToken(environmentId, token.trim()))}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Save
            </Button>
          </div>
          {telegram.botCreation?.available ? (
            <CardRow
              id="rubato-companion-telegram-create"
              title="Or let Rubato make it"
              description="Rubato asks @BotFather from your own Telegram account and keeps the token. Nothing for you to do in Telegram."
              control={
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => void run(() => rubatoCompanion.createTelegramBot(environmentId, botName))}>
                  {busy ? <Spinner className="size-3.5" /> : null}
                  Create the bot
                </Button>
              }
            />
          ) : null}
        </>
      ) : (
        <CardRow
          id="rubato-companion-telegram-bot"
          title={telegram.bot.name ?? `${title}'s bot`}
          description={telegram.bot.username ? `@${telegram.bot.username}` : `The bot Rubato made for ${title}.`}
          control={telegram.bot.token ? <Badge variant="outline">{telegram.bot.token}</Badge> : null}
        />
      )}
      {telegram.handoff.error ? (
        <CardRow id="rubato-companion-telegram-error" title="The last Telegram request failed" description={telegram.handoff.error} />
      ) : null}
      {made && !paired ? (
        <CardRow
          id="rubato-companion-telegram-pair"
          title="Pair your chat"
          description={
            waiting
              ? "Open the bot in Telegram and send it this code. Send it before the code is replaced."
              : "Only the chat that sends this code becomes yours; nothing else counts as you."
          }
          control={
            <>
              {waiting && telegram.pairing.code ? <Badge variant="outline">{telegram.pairing.code}</Badge> : null}
              <Button size="sm" disabled={busy} onClick={() => void run(() => rubatoCompanion.pairTelegram(environmentId))}>
                {waiting ? "New code" : "Pair"}
              </Button>
            </>
          }
        />
      ) : null}
      {paired ? (
        <CardRow
          id="rubato-companion-telegram-chat"
          title="Your chat"
          description={telegram.pairing.chat?.name ?? telegram.pairing.chat?.chatId ?? ""}
          control={
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void run(() => rubatoCompanion.unpairTelegram(environmentId))}>
              Unpair
            </Button>
          }
        />
      ) : null}
      <CardRow
        id="rubato-companion-telegram-approval"
        title="Hold messages to others"
        description={`Anything ${title} writes to someone other than you waits here, and in your Telegram chat, until you approve it.`}
        control={
          <Switch
            aria-label="Hold messages to others"
            checked={telegram.settings.approvalRequired}
            disabled={busy}
            onCheckedChange={(next) => void run(() => rubatoCompanion.saveTelegramSettings(environmentId, { approvalRequired: next }))}
          />
        }
      />
    </div>
  );
}

function telegramState(telegram: TelegramStatus): string {
  if (telegram.bot.token == null) return "No bot yet";
  if (telegram.pairing.status === "paired") return telegram.settings.enabled ? "Connected" : "Off";
  if (telegram.pairing.status === "pending") return "Waiting for the code";
  return "Not paired";
}

function ConnectionsCard({ companion, title }: { companion: CompanionChoice; title: string }) {
  const environmentId = useReadyEnvironmentId();
  const { telegram, busy, error, off, run } = useTelegram(environmentId);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceKey, setVoiceKey] = useState("");
  const showTelegram = companion.telegram === true && telegram !== null;
  const showVoice = telegram !== null;
  const waiting = telegram?.waiting ?? [];
  return (
    <Card id="rubato-companion-connections" title="Connections">
      {error && !off ? <CardRow title="Could not read the Telegram connection" description={error} /> : null}
      {showTelegram ? (
        <>
          <CardRow
            id="rubato-companion-telegram"
            title="Telegram"
            description={telegramState(telegram)}
            control={
              <>
                {waiting.length > 0 ? <Badge variant="warning">{waiting.length}</Badge> : null}
                <Button size="xs" variant="outline" aria-expanded={telegramOpen} onClick={() => setTelegramOpen((value) => !value)}>
                  {telegramOpen ? "Close" : telegram.bot.token == null ? "Connect" : "Manage"}
                </Button>
              </>
            }
          />
          {telegramOpen ? (
            <TelegramDetails environmentId={environmentId} title={title} botName={companion.title} telegram={telegram} busy={busy} run={run} />
          ) : null}
        </>
      ) : null}
      {showVoice ? (
        <>
          <CardRow
            id="rubato-companion-voice"
            title="Its voice"
            description={
              <>
                Fish Audio · <span translate={telegram.settings.voice?.voiceId ? "no" : undefined}>{telegram.settings.voice?.voiceId ?? "Not chosen"}</span>
              </>
            }
            control={
              <Button size="xs" variant="outline" aria-expanded={voiceOpen} onClick={() => setVoiceOpen((value) => !value)}>
                {voiceOpen ? "Close" : "Change"}
              </Button>
            }
          />
          {voiceOpen ? (
            <div data-rubato-companion-voice="" className="mb-2 flex flex-col gap-2 rounded-xl border border-border px-3 py-2">
              <p className="text-muted-foreground text-xs">{`Voice replies speak in this Fish Audio voice. Ask ${title} to pick or change it.`}</p>
              <div className="flex items-center gap-2">
                <span className="text-sm">Fish Audio key</span>
                <Badge variant={telegram.fishKey ? "success" : "outline"}>{telegram.fishKey ?? "Not set"}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Fish Audio API key"
                  className="h-8 flex-1"
                  value={voiceKey}
                  disabled={busy}
                  onChange={(event) => setVoiceKey(event.target.value)}
                />
                <Button size="sm" disabled={busy || voiceKey.trim() === ""}
                  onClick={() => void run(async () => {
                    const next = await rubatoCompanion.setVoiceKey(environmentId, voiceKey.trim());
                    setVoiceKey("");
                    return next;
                  })}>
                  Save
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {companion.calls ? (
        <CardRow id="rubato-companion-calls" title="Calls" description="Takes calls on your phone" control={<Badge variant="success">On</Badge>} />
      ) : null}
      {!showTelegram && !showVoice && !companion.calls ? (
        <p className="py-1.5 text-muted-foreground text-sm">Nothing connected yet.</p>
      ) : null}
      {/* Messages to other people wait here until the person decides, whether or not the rows are open. */}
      {waiting.map((message) => (
        <CardRow
          key={message.id}
          id={`rubato-companion-telegram-held-${message.id}`}
          title={`For ${HELD_KIND(message)}`}
          description={message.text}
          control={
            <>
              <Button size="xs" disabled={busy}
                onClick={() => void run(() => rubatoCompanion.decideTelegram(environmentId, message.id, "approve"))}>
                Approve
              </Button>
              <Button size="xs" variant="outline" disabled={busy}
                onClick={() => void run(() => rubatoCompanion.decideTelegram(environmentId, message.id, "reject"))}>
                Reject
              </Button>
            </>
          }
        />
      ))}
    </Card>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────

export function RubatoCompanionSettingsPanel() {
  const { companions, selectedId } = useRubatoCompanion();
  const selected = companions.find((item) => item.id === selectedId) ?? companions[0];
  return (
    <div id="rubato-companion" data-rubato-companion-page="" className="flex min-w-0 items-start gap-6">
      <CompanionList companions={companions} selectedId={selected?.id ?? selectedId} />
      <div className="min-w-0 flex-1">
        {selected ? (
          <CompanionDetail key={selected.id} companion={selected} />
        ) : (
          <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            <span>Reading the companion</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CompanionDetail({ companion }: { companion: CompanionChoice }) {
  const environmentId = useReadyEnvironmentId();
  const language = useLanguage();
  const openRoom = useOpenCompanionRoom();
  // Its name as the page shows it ("New companion" in the interface's language), for phrases built here.
  const name = useUiText(companion.title);
  const title = companion.title;
  const threadId = companion.threadId;
  const [pieces, setPieces] = useState<CompanionPiece[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  // "Full text" opens Advanced at the card's piece.
  const [focusPiece, setFocusPiece] = useState<{ id: CompanionPieceId; at: number } | null>(null);
  const { summaries, loaded } = useSummaries(environmentId, companion.id);

  const loadPieces = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setPieces((await rubatoCompanion.pieces(environmentId)).pieces);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);
  useEffect(() => {
    void loadPieces();
  }, [loadPieces]);

  /** Resolves true when the engine kept the change, false when it refused it (the toast says why). */
  const save = async (patch: CompanionSettingsPatch): Promise<boolean> => {
    setBusy(true);
    let kept = false;
    try {
      acceptCompanionStatus(await rubatoCompanion.saveSettings(environmentId, patch));
      kept = true;
    } catch (cause) {
      reportError("Could not save the companion settings", cause);
    }
    setBusy(false);
    return kept;
  };
  const savePiece = async (id: CompanionPieceId, text: string) => {
    setBusy(true);
    try {
      setPieces((await rubatoCompanion.savePiece(environmentId, id, text)).pieces);
    } catch (cause) {
      reportError("Could not save the piece", cause);
    }
    setBusy(false);
  };
  const reviewPersona = async () => {
    setBusy(true);
    try {
      const next = await rubatoCompanion.reviewPersona(environmentId);
      setPieces(next.pieces);
      setReviewPending(true);
      toastManager.add({
        type: "info",
        title: `${name} will look at it`,
        description: "It reads your file and Rubato's, then tells you what it recommends. Nothing changes until you say so.",
      });
    } catch (cause) {
      reportError(`Could not ask ${name} to review`, cause);
    }
    setBusy(false);
  };

  // While a review is on its way, read the pieces again until the companion has seen the new default.
  useEffect(() => {
    if (!reviewPending) return;
    const timer = window.setInterval(() => void loadPieces(), 3_000);
    return () => window.clearInterval(timer);
  }, [reviewPending, loadPieces]);
  useEffect(() => {
    if (reviewPending && pieces !== null && !pieces.some((piece) => piece.defaultChanged)) setReviewPending(false);
  }, [pieces, reviewPending]);
  useEffect(() => {
    if (focusPiece === null) return;
    const frame = window.requestAnimationFrame(() =>
      document.getElementById(`rubato-companion-piece-${focusPiece.id}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusPiece, pieces]);

  const talk = (draft?: CompanionDraft) => void openRoom(threadId, draft === undefined ? undefined : companionDraft(draft, language));
  const fullText = (id: CompanionPieceId) => {
    setAdvanced(true);
    setFocusPiece({ id, at: Date.now() });
  };

  const settings = companion.settings;
  const enabled = settings.enabled === true;
  const meta = [
    companion.profile?.callsUser ? companionLine("calls-user", companion.profile.callsUser, language) : null,
    sinceLine(companion.profile?.since, language),
  ].filter((part): part is string => part !== null);

  return (
    <div data-rubato-companion-detail={companion.id} className="flex min-w-0 flex-col gap-4">
      <header className="flex items-center gap-5">
        <RubatoCompanionPicture companion={companion} environmentId={environmentId} onAskToDraw={() => talk("draw")} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate font-bold text-2xl">{companion.title}</h2>
          {meta.length > 0 ? (
            <p className="truncate text-muted-foreground text-sm" translate="no">
              {meta.join(" · ")}
            </p>
          ) : companion.onboarding ? (
            <p className="truncate text-muted-foreground text-sm">Getting to know you</p>
          ) : null}
        </div>
        <Switch
          aria-label={`Turn ${name} on`}
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => void save({ enabled: next })}
        />
        <Button size="sm" variant="outline" disabled={threadId === null || environmentId === null} onClick={() => talk()}>
          {enabled && threadId === null ? <Spinner className="size-3.5" /> : null}
          Talk
        </Button>
      </header>

      <RubatoCompanionIconSetting key={companion.id} companion={companion} environmentId={environmentId}
        onAsk={threadId === null ? undefined : () => talk("draw-icon")} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SummaryCard
          id="rubato-companion-who"
          title={companionLine("who-title", name, language)}
          card={summaries?.who}
          labels={WHO_ROWS}
          loaded={loaded}
          waitingText="Not summed up yet."
          canTalk={threadId !== null}
          onTalk={() => talk("who")}
          onSumUp={() => talk("sum-up-who")}
          onFullText={() => fullText("soul")}
        />
        <SummaryCard
          id="rubato-companion-me"
          title={companionLine("me-title", name, language)}
          card={summaries?.me}
          labels={ME_ROWS}
          loaded={loaded}
          waitingText="Not summed up yet."
          canTalk={threadId !== null}
          onTalk={() => talk("me")}
          onSumUp={() => talk("sum-up-me")}
          onFullText={() => fullText("user")}
        />

        <Card id="rubato-companion-life" title="Life">
          <CardRow
            id="rubato-companion-heartbeat"
            title="Heartbeat"
            description="How often it wakes while on its own"
            control={
              <>
                <Select
                  value={String(settings.heartbeat.everyMinutes)}
                  onValueChange={(next) => {
                    if (typeof next === "string") void save({ heartbeat: { everyMinutes: Number(next) } });
                  }}
                >
                  <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Heartbeat interval" disabled={busy || !settings.heartbeat.enabled}>
                    <SelectValue>{minutesLabel(settings.heartbeat.everyMinutes)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(companion.heartbeatMinutes ?? []).map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {minutesLabel(minutes)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Switch
                  aria-label="Heartbeat"
                  checked={settings.heartbeat.enabled}
                  disabled={busy}
                  onCheckedChange={(next) => void save({ heartbeat: { enabled: next } })}
                />
              </>
            }
          />
          <CardRow
            id="rubato-companion-greetings"
            title="Night and morning greetings"
            description="Its diary and good night at 00:07, the day's report at 09:07"
            control={
              <Switch
                aria-label="Night and morning greetings"
                checked={settings.greetings.enabled}
                disabled={busy}
                onCheckedChange={(next) => void save({ greetings: { enabled: next } })}
              />
            }
          />
          <CardRow
            id="rubato-companion-schedule"
            title="Keeping your schedule"
            description={
              settings.schedule.sources.length === 0 ? (
                "No calendar yet. Tell it where yours is."
              ) : (
                <span translate="no">{settings.schedule.sources.map((source) => source.name ?? source.location).join(", ")}</span>
              )
            }
          />
          {companion.calls ? (
            <CardRow
              id="rubato-companion-call-effort"
              title="Thinking level on calls"
              description="Less thinking answers sooner"
              control={
                <Select
                  value={settings.call.effort}
                  onValueChange={(next) => {
                    if (typeof next === "string") void save({ call: { effort: next as CallEffort } });
                  }}
                >
                  <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Thinking on calls" disabled={busy}>
                    <SelectValue>{CALL_EFFORT_LABELS[settings.call.effort]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {(companion.callEfforts ?? (Object.keys(CALL_EFFORT_LABELS) as CallEffort[])).map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {CALL_EFFORT_LABELS[effort]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
        </Card>

        <ConnectionsCard companion={companion} title={name} />

        {settings.dream ? (
          <Card id="rubato-companion-dream" title="Dream">
            <CompanionDreamModels models={settings.dream.models ?? []} busy={busy} save={save} />
            <DocsUpkeep docs={settings.dream.docs} busy={busy} save={save} />
          </Card>
        ) : null}
      </div>

      <section data-rubato-companion-advanced="" className="rounded-2xl border border-border">
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
          className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-muted-foreground text-sm hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span>Advanced — how it works · tools · resident memory · opening and closing lines · Rubato&apos;s defaults</span>
          <ChevronRightIcon aria-hidden="true" className={cn("size-4 shrink-0 transition-transform", advanced && "rotate-90")} />
        </button>
        {advanced ? (
          <div className="border-border border-t px-2 pb-2">
            <SettingsSection id="rubato-companion-prompt" title={`${name}'s prompt`}>
              {error ? <SettingsRow title="Could not read the companion" description={error} /> : null}
              {pieces === null && !error ? (
                <SettingsRow title="Reading the prompt" control={<Spinner className="size-4" />} />
              ) : null}
              <SettingsRow
                id="rubato-companion-review"
                title="Rubato's defaults"
                description={`When Rubato changes who ${name} is by default, ${name} compares it with your own file and tells you what it recommends. Nothing is merged without you.`}
                status={
                  pieces?.some((piece) => piece.defaultChanged) ? (
                    <Badge variant="warning">Default update available</Badge>
                  ) : reviewPending ? (
                    <Badge variant="outline">Reviewing</Badge>
                  ) : null
                }
                control={
                  <Button size="sm" variant="outline" disabled={busy || pieces === null} onClick={() => void reviewPersona()}>
                    {`Have ${name} review it`}
                  </Button>
                }
              />
              {pieces?.map((piece) => (
                <PieceEditor
                  key={`${piece.id}:${piece.personalText ?? ""}:${focusPiece?.id === piece.id ? focusPiece.at : 0}`}
                  piece={piece}
                  busy={busy}
                  initiallyOpen={focusPiece?.id === piece.id}
                  onSave={(text) => savePiece(piece.id, text)}
                />
              ))}
            </SettingsSection>
          </div>
        ) : null}
      </section>
    </div>
  );
}
