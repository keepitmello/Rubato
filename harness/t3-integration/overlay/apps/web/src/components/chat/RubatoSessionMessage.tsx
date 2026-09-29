import { MessagesSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A message another Rubato conversation sent into this one. The bridge stores it
 * as a user message (it opens a turn the way a prompt does) with one context
 * record of kind `rubato-session`; that record is what tells it apart from what
 * the person typed. See harness/t3-integration/src/events.mjs sessionMessageFrom.
 */
export const RUBATO_SESSION_CONTEXT_KIND = "rubato-session";

export interface RubatoSessionMessageLink {
  /** The sending conversation's title; empty when it had none. */
  readonly title: string;
  /** `create`: the sender started this conversation with it. */
  readonly kind: "message" | "create";
  readonly fromSessionId: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function rubatoSessionMessageOf(message: {
  readonly role: string;
  readonly context?: unknown;
}): RubatoSessionMessageLink | null {
  if (message.role !== "user") return null;
  const records = record(message.context)?.records;
  if (!Array.isArray(records)) return null;
  for (const item of records) {
    const entry = record(item);
    if (entry?.kind !== RUBATO_SESSION_CONTEXT_KIND) continue;
    const payload = record(entry.payload);
    const from = record(payload?.from);
    const title =
      typeof from?.title === "string"
        ? from.title.trim()
        : typeof entry.label === "string"
          ? entry.label.trim()
          : "";
    return {
      title,
      kind: payload?.kind === "create" ? "create" : "message",
      fromSessionId: typeof from?.sessionId === "string" ? from.sessionId : null,
    };
  }
  return null;
}

export function rubatoSessionMessageHeading(link: RubatoSessionMessageLink): string {
  const title = link.title || "another conversation";
  return link.kind === "create" ? `Started by ${title}` : `From ${title}`;
}

/**
 * Sits on the left like an incoming message, framed and headed by the sender,
 * so it reads as neither the person's own bubble (right, filled) nor the
 * assistant's answer (left, unframed prose).
 */
export function RubatoSessionMessageBubble(props: {
  link: RubatoSessionMessageLink;
  children: ReactNode;
  meta?: ReactNode;
}) {
  const heading = rubatoSessionMessageHeading(props.link);
  return (
    <div className="group flex flex-col items-start gap-1" data-rubato-session-message="true">
      <div className="relative max-w-[80%] rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-xs">
        <h3 className="sr-only select-none">{heading}</h3>
        <div
          aria-hidden="true"
          className="mb-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
          data-rubato-session-from={props.link.title}
        >
          <MessagesSquareIcon className="size-3.5 shrink-0" />
          <span className="shrink-0">{props.link.kind === "create" ? "Started by" : "From"}</span>
          <span className="min-w-0 truncate font-medium text-foreground">
            {props.link.title || "another conversation"}
          </span>
        </div>
        {props.children}
      </div>
      {props.meta ? (
        <div className="flex w-full max-w-[80%] items-center justify-start ps-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
          {props.meta}
        </div>
      ) : null}
    </div>
  );
}
