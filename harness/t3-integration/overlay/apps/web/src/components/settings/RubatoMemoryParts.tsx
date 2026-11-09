// Small pieces the memory page's views share: a card with a header line, a row, the tag that says who
// reads a line, relative times in the interface language, and what the person put away on this device.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { UI_LANGUAGE_STORAGE_KEY, uiText } from "../../rubatoI18n";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { SegnoMemoryView } from "../../state/rubatoSegnoMemory";

export function MemoryCard({
  title,
  aside,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("overflow-hidden rounded-xl border border-border/70 bg-card", className)}>
      {title !== undefined ? (
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          {aside !== undefined ? <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{aside}</div> : null}
        </header>
      ) : null}
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

export function MemoryRow({
  children,
  actions,
  onClick,
  selected = false,
  className,
  ...rest
}: {
  children: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const body = (
    <>
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{actions}</div> : null}
    </>
  );
  const classes = cn(
    "group/row flex items-start gap-3 px-4 py-2.5 text-sm",
    onClick && "cursor-pointer hover:bg-accent/40",
    selected && "bg-accent/60",
    className,
  );
  return onClick ? (
    <div
      {...rest}
      role="button"
      tabIndex={0}
      className={classes}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {body}
    </div>
  ) : (
    <div {...rest} className={classes}>
      {body}
    </div>
  );
}

export type TagTone = "all" | "companion" | "decision" | "reference" | "attention" | "quiet";
const TAG_TONE: Record<TagTone, string> = {
  all: "bg-teal-600/10 text-teal-700 dark:text-teal-300",
  companion: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  decision: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  reference: "bg-muted text-muted-foreground",
  attention: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  quiet: "bg-muted/60 text-muted-foreground",
};

export function Tag({ tone, children, className }: { tone: TagTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] leading-5 whitespace-nowrap", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mt-0.5 text-xs text-muted-foreground", className)}>{children}</div>;
}

// Relative times in the interface language; the dictionary cannot template every unit.
function korean(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) === "ko";
}
let relative: Intl.RelativeTimeFormat | null = null;
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  relative ??= new Intl.RelativeTimeFormat(korean() ? "ko" : "en", { numeric: "auto" });
  const seconds = Math.round((then - Date.now()) / 1000);
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, "second");
}

/** A date and time, short: "11-09 03:00". */
export function shortStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-11-08" → "11-08". */
export function monthDay(date: string): string {
  return /^\d{4}-(\d{2}-\d{2})$/.exec(date)?.[1] ?? date;
}

export function reportError(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
}

export async function confirmAction(message: string, destructive = false): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: destructive ? "destructive" : "default" });
  return answer ? await answer : window.confirm(message);
}

const DISMISSED_KEY = "rubato:memory-page:dismissed";

/** Ids the person put away on this device (a "needs you" item, an overlap kept as it is). */
export function useDismissed(): { readonly dismissed: ReadonlySet<string>; readonly dismiss: (id: string) => void } {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  });
  const dismiss = useCallback((id: string) => {
    setDismissed((current) => {
      const next = new Set([...current, id]);
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-500)));
      } catch {
        // Storage refused (a private window): it holds for this visit.
      }
      return next;
    });
  }, []);
  return { dismissed, dismiss };
}

export function ViewHeading({ title, sub }: { title: ReactNode; sub: ReactNode }) {
  return (
    <div className="space-y-1 px-1">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}


/** Where the person writes an answer for the companion; it is sent as their message in its conversation. */
export function AnswerBox({
  companion,
  placeholder,
  onSend,
  onCancel,
}: {
  companion: string;
  placeholder?: string | undefined;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = async () => {
    if (text.trim() === "" || sending) return;
    setSending(true);
    try {
      await onSend(text);
    } catch (error) {
      reportError(`Could not send to ${companion}`, error);
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        ref={ref}
        rows={2}
        value={text}
        aria-label={uiText(`Your answer for ${companion}`)}
        placeholder={uiText(placeholder ?? `Your answer. It goes to ${companion}'s conversation as your message.`)}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={sending || text.trim() === ""}>
          {sending ? <Spinner className="size-3" /> : null}
          {`Send to ${companion}`}
        </Button>
      </div>
    </form>
  );
}


/**
 * Parts of one line joined with " · ", each its own element so the interface translation finds every
 * part on its own. `keep` parts are a person's or a model's words and stay as written.
 */
type DotPart = string | { readonly keep: string; readonly lead?: string };

export function Dots({ parts }: { parts: ReadonlyArray<DotPart | null | false | undefined> }) {
  const shown = parts.filter((part): part is DotPart => Boolean(part));
  return (
    <>
      {shown.map((part, index) => (
        // Parts have no identity beyond their place in the line.
        <span key={index}>
          {index > 0 ? " · " : null}
          {typeof part === "string" ? (
            <span>{part}</span>
          ) : (
            <>
              {part.lead ? <span>{part.lead}</span> : null}
              {part.lead ? " " : null}
              <span translate="no">{part.keep}</span>
            </>
          )}
        </span>
      ))}
    </>
  );
}

/** A companion's view with its name as the interface says it ("Segno" is 세뇨 in Korean). */
export function namedInInterface(view: SegnoMemoryView): SegnoMemoryView {
  return { ...view, title: uiText(view.title) };
}

