import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { postRubato } from "~/state/rubatoHttp";
import { environmentServerConfigsAtom } from "~/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "../ui/dialog";
import {
  Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The new-thread screen's "시스템 프롬프트" chip and the badge a started thread keeps.
// A Rubato conversation can open with another prompt in place of Rubato's own; that text is
// its whole system prompt for its whole life. The server half is /rubato/session-prompts
// (RubatoSessionPrompt.ts); the library is files on the Mac (bridge session-prompts.mjs).

const ROUTE = "/rubato/session-prompts";
const WHAT = "system prompts";
const LAST_CHOICE_KEY = "rubato.sessionPrompt.last";
const DEFAULT_VALUE = "default";
const INLINE_VALUE = "inline";

export interface SessionPromptEntry {
  readonly id: string;
  readonly label: string;
  readonly source: string;
}
export interface SessionPromptSummary {
  readonly label?: string;
  readonly source?: string;
  readonly createdAt?: string;
}
export type SessionPromptChoice =
  | { readonly kind: "default" }
  | { readonly kind: "file"; readonly id: string; readonly label: string; readonly source: string }
  | { readonly kind: "text"; readonly text: string; readonly label: string; readonly source?: string };

const DEFAULT_CHOICE: SessionPromptChoice = { kind: "default" };

// One choice per draft, kept outside React so the send path reads what the chip shows.
const choices = new Map<string, SessionPromptChoice>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function sessionPromptChoice(draftKey: string | null): SessionPromptChoice {
  return (draftKey === null ? undefined : choices.get(draftKey)) ?? DEFAULT_CHOICE;
}
function setSessionPromptChoice(draftKey: string, choice: SessionPromptChoice, remember: boolean) {
  choices.set(draftKey, choice);
  if (remember) {
    try { localStorage.setItem(LAST_CHOICE_KEY, choice.kind === "file" ? choice.id : DEFAULT_VALUE); } catch {}
  }
  notify();
}
function lastChoiceId(): string | null {
  try { return localStorage.getItem(LAST_CHOICE_KEY); } catch { return null; }
}

/** Whether `instanceId` is a Rubato provider in this environment: only Rubato sessions take a prompt. */
type ProviderConfigs = {
  get(environmentId: EnvironmentId): { readonly providers?: ReadonlyArray<{ readonly instanceId: string; readonly driver: string }> } | undefined;
};

export function runsOnRubato(
  configs: ProviderConfigs,
  environmentId: EnvironmentId,
  instanceId: string | null,
): boolean {
  if (instanceId === null) return false;
  const providers = configs.get(environmentId)?.providers ?? [];
  return providers.some((provider) => provider.instanceId === instanceId && provider.driver === "rubato-pi");
}

// What a started thread runs on, by environment and thread. A prepared prompt is put here before
// the thread's first message, so the badge needs no round trip for the thread just started.
const summaries = new Map<string, SessionPromptSummary | null>();
const summaryKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

/**
 * Just before a draft's first message: the thread's Rubato session opens with the draft's prompt.
 * Nothing to do for Rubato's own prompt or another provider. A failure stops the send.
 */
export async function prepareRubatoSessionPrompt(input: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string | null;
  readonly threadId: string;
  readonly instanceId: string;
}): Promise<void> {
  const choice = sessionPromptChoice(input.draftKey);
  if (choice.kind === "default") return;
  if (!runsOnRubato(appAtomRegistry.get(environmentServerConfigsAtom), input.environmentId, input.instanceId)) return;
  const body = choice.kind === "file"
    ? { id: choice.id }
    : { text: choice.text, label: choice.label };
  const { prompt } = await postRubato<{ prompt: SessionPromptSummary }>(
    input.environmentId, ROUTE, "prepare",
    { instanceId: input.instanceId, threadId: input.threadId, ...body }, WHAT,
  );
  summaries.set(summaryKey(input.environmentId, input.threadId), { ...prompt, createdAt: new Date().toISOString() });
  if (input.draftKey !== null) choices.delete(input.draftKey);
}

function choiceValue(choice: SessionPromptChoice): string {
  return choice.kind === "default" ? DEFAULT_VALUE : choice.kind === "file" ? choice.id : INLINE_VALUE;
}
function choiceLabel(choice: SessionPromptChoice): string {
  return choice.kind === "default" ? "Rubato 기본" : choice.label;
}
const displayPath = (source: string) => source.replace(/^\/Users\/[^/]+/, "~");

export function RubatoSessionPromptChip(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string | null;
  readonly instanceId: string | null;
}) {
  const { environmentId, draftKey, instanceId } = props;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const rubato = runsOnRubato(configs, environmentId, instanceId);
  const choice = useSyncExternalStore(subscribe, () => sessionPromptChoice(draftKey));
  const [library, setLibrary] = useState<ReadonlyArray<SessionPromptEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    if (!instanceId) return null;
    try {
      const { prompts } = await postRubato<{ prompts: ReadonlyArray<SessionPromptEntry> }>(
        environmentId, ROUTE, "list", { instanceId }, WHAT,
      );
      setLibrary(prompts);
      setError(null);
      return prompts;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  // A new draft starts on the last file chosen, while that file is still in the library.
  useEffect(() => {
    if (!rubato || draftKey === null) return;
    let cancelled = false;
    void load().then((prompts) => {
      if (cancelled || !prompts || choices.has(draftKey)) return;
      const last = lastChoiceId();
      const entry = prompts.find((item) => item.id === last);
      if (entry) setSessionPromptChoice(draftKey, { kind: "file", ...entry }, false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubato, draftKey, environmentId, instanceId]);

  if (!rubato || draftKey === null) return null;

  const choose = (value: string) => {
    if (value === DEFAULT_VALUE) return setSessionPromptChoice(draftKey, DEFAULT_CHOICE, true);
    const entry = library?.find((item) => item.id === value);
    if (entry) setSessionPromptChoice(draftKey, { kind: "file", ...entry }, true);
  };
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    if (!text.trim()) { setError(`${file.name} is empty.`); return; }
    setSessionPromptChoice(draftKey, { kind: "text", text, label: file.name.replace(/\.(md|markdown|txt)$/i, ""), source: file.name }, false);
  };
  const openFolder = async () => {
    try { await postRubato(environmentId, ROUTE, "open-folder", { instanceId }, WHAT); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const replaced = choice.kind !== "default";

  return (
    <div className="pointer-events-auto mt-3 flex flex-col items-center gap-1.5 text-sm" data-rubato-session-prompt="">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>시스템 프롬프트</span>
        <Menu onOpenChange={(open) => { if (open) void load(); }}>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex max-w-64 items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-0.5 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  replaced ? "border-primary/60 ring-2 ring-primary/20" : "border-border",
                )}
              />
            }
          >
            <SparklesIcon aria-hidden className={cn("size-3.5 shrink-0", replaced ? "text-primary" : "text-muted-foreground")} />
            <span className="min-w-0 truncate">{choiceLabel(choice)}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="center" className="max-h-96 w-80 overflow-y-auto">
            <MenuRadioGroup value={choiceValue(choice)} onValueChange={(value) => choose(String(value))}>
              <MenuRadioItem value={DEFAULT_VALUE} closeOnClick>
                <span className="grid gap-0.5 py-0.5">
                  <span>Rubato 기본</span>
                  <span className="text-muted-foreground text-xs">레아 · 역할별 프롬프트</span>
                </span>
              </MenuRadioItem>
              {(library ?? []).map((entry) => (
                <MenuRadioItem key={entry.id} value={entry.id} closeOnClick>
                  <span className="grid min-w-0 gap-0.5 py-0.5">
                    <span className="truncate">{entry.label}</span>
                    <span className="truncate font-mono text-muted-foreground text-xs">{displayPath(entry.source)}</span>
                  </span>
                </MenuRadioItem>
              ))}
              {choice.kind === "text" ? (
                <MenuRadioItem value={INLINE_VALUE} closeOnClick>
                  <span className="grid min-w-0 gap-0.5 py-0.5">
                    <span className="truncate">{choice.label}</span>
                    <span className="text-muted-foreground text-xs">이번 대화만</span>
                  </span>
                </MenuRadioItem>
              ) : null}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onClick={() => setWriting(true)}>이번 대화만 직접 쓰기…</MenuItem>
            <MenuItem onClick={() => fileInput.current?.click()}>다른 파일 고르기…</MenuItem>
            <MenuItem onClick={() => void openFolder()}>프롬프트 폴더 열기</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
      <input
        ref={fileInput}
        type="file"
        accept=".md,.markdown,.txt,text/plain,text/markdown"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void pickFile(file);
        }}
      />
      {writing ? (
        <WriteSessionPromptDialog
          initial={choice.kind === "text" && choice.source === undefined ? choice : null}
          onClose={() => setWriting(false)}
          onUse={(text, label) => {
            setSessionPromptChoice(draftKey, { kind: "text", text, label }, false);
            setWriting(false);
          }}
        />
      ) : null}
    </div>
  );
}

function WriteSessionPromptDialog(props: {
  readonly initial: { readonly text: string; readonly label: string } | null;
  readonly onClose: () => void;
  readonly onUse: (text: string, label: string) => void;
}) {
  const [text, setText] = useState(props.initial?.text ?? "");
  const [label, setLabel] = useState(props.initial?.label ?? "");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogPopup className="max-w-2xl">
        {/* `contents`: header, panel and footer stay the popup's own rows, as in other dialogs. */}
        <form className="contents" onSubmit={(event) => { event.preventDefault(); if (text.trim()) props.onUse(text, label.trim() || "직접 쓴 프롬프트"); }}>
          <DialogHeader>
            <DialogTitle>이번 대화만 직접 쓰기</DialogTitle>
            <DialogDescription>
              여기 쓴 글이 이 대화의 시스템 프롬프트 전부가 돼. 파일로 남지 않아.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="이름 (헤더 배지에 보여)"
              autoComplete="off"
              spellCheck={false}
            />
            <Textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="You are…"
              className="min-h-64 font-mono text-sm"
              spellCheck={false}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>취소</Button>
            <Button type="submit" disabled={!text.trim()}>이 프롬프트로 시작</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const formatWhen = (iso: string | undefined) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** The header badge of a thread whose Rubato session runs on its own prompt. Nothing otherwise. */
export function RubatoSessionPromptBadge(props: { readonly environmentId: EnvironmentId; readonly threadId: string }) {
  const { environmentId, threadId } = props;
  const key = summaryKey(environmentId, threadId);
  const [summary, setSummary] = useState<SessionPromptSummary | null>(() => summaries.get(key) ?? null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const known = summaries.get(key);
    setSummary(known ?? null);
    if (known !== undefined) return;
    // The first message binds the session a moment after the thread appears; ask until it has.
    const ask = async (attempt: number) => {
      try {
        const answer = await postRubato<{ prompt: SessionPromptSummary | null; started: boolean }>(
          environmentId, ROUTE, "thread", { threadId }, WHAT,
        );
        if (cancelled) return;
        if (!answer.started && attempt < 20) { timer = setTimeout(() => void ask(attempt + 1), 1500); return; }
        summaries.set(key, answer.prompt);
        setSummary(answer.prompt);
      } catch {
        // An older Mac without the route, or no connection: no badge.
      }
    };
    void ask(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [environmentId, threadId, key]);

  if (!summary) return null;
  const label = summary.label ?? "바꾼 프롬프트";
  const when = formatWhen(summary.createdAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-rubato-session-prompt-badge=""
            className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 text-primary text-xs"
          />
        }
      >
        <SparklesIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-sm">
        <div className="grid gap-1 text-xs leading-5">
          <span className="font-medium">이 대화는 {label} 프롬프트로 시작했어</span>
          {summary.source || when ? (
            <span className="text-muted-foreground">
              {[summary.source ? displayPath(summary.source) : null, when ? `${when} 내용 그대로` : null].filter(Boolean).join(" · ")}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {summary.source ? "파일을 고쳐도 이 대화는 그대로야. " : ""}갈래 대화도 같은 프롬프트를 이어받아.
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
