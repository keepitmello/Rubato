// A companion's own records (Segno's status board, questions, what it knows about the person,
// dated records, people and companies), as the memory page and Segno's room panel read them. The
// T3 server answers at /rubato/memory/companion-* (harness/t3-integration/src/memory/companion.mjs);
// nothing there writes the companion's files.
//
// Changing them goes through the companion: `useCompanionSender` sends the person's own message into
// the companion's conversation, the same turn the room's composer starts, and the companion decides
// what to write. `markSent` remembers which line the message was about, so both surfaces can show it.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { newMessageId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadProjection } from "./entities";
import { useRubatoCompanion } from "./rubatoCompanion";
import { postRubato } from "./rubatoHttp";
import { threadEnvironment } from "./threads";

const MEMORY_ROUTE = "/rubato/memory";

export interface SegnoLine {
  /** Stable while the line's text and file stay the same. */
  readonly id: string;
  readonly text: string;
  /** Where the companion noted it came from ("daily 10-22·10-23"), when it did. */
  readonly refs: string | null;
  /** When the person sent the companion a message about this line, from this page or the room. */
  readonly sent?: string;
}

export interface SegnoQuestion extends SegnoLine {
  /** A line the companion suggests adding to its own prompt, not a question. */
  readonly proposal: boolean;
}

export interface SegnoAboutLine extends SegnoLine {
  readonly file: string;
  /** user: about the person; us: about the two of them. */
  readonly kind: "user" | "us";
  readonly updatedAt: string | null;
}

export interface SegnoDay {
  readonly date: string;
  readonly daily: string | null;
  readonly diary: string | null;
  readonly headline: string;
}

export interface SegnoWeek {
  readonly week: string;
  readonly path: string;
  readonly headline: string;
}

export interface SegnoEntity {
  readonly name: string;
  readonly path: string;
  readonly summary: string | null;
  readonly aka: readonly string[];
  readonly tags: readonly string[];
  readonly updated: string | null;
}

export interface SegnoDreamState {
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly reason: string | null;
  readonly attempts: ReadonlyArray<{ readonly model: string; readonly ok: boolean; readonly error?: string }>;
  readonly blocks: Readonly<Record<string, string | null>>;
}

export interface SegnoMemoryView {
  readonly id: string;
  readonly title: string;
  readonly home: string;
  readonly exists: boolean;
  readonly status: {
    readonly path: string;
    readonly updatedAt: string | null;
    readonly sections: ReadonlyArray<{ readonly title: string; readonly items: readonly SegnoLine[] }>;
  } | null;
  readonly questions: { readonly path: string; readonly updatedAt: string | null; readonly items: readonly SegnoQuestion[] } | null;
  readonly about: readonly SegnoAboutLine[];
  readonly records: readonly SegnoDay[];
  readonly weekly: readonly SegnoWeek[];
  readonly entities: readonly SegnoEntity[];
  readonly dream: SegnoDreamState | null;
}

export interface SegnoCommit {
  readonly sha: string;
  readonly at: string;
  readonly subject: string;
}

const call = <T>(env: EnvironmentId | null, action: string, body: Record<string, unknown>) =>
  postRubato<T>(env, MEMORY_ROUTE, action, body, "memory settings");

export const rubatoSegnoMemory = {
  companions: (env: EnvironmentId | null) =>
    call<{ companions: ReadonlyArray<{ id: string; title: string; hasMemory: boolean }> }>(env, "companions", {}),
  memory: (env: EnvironmentId | null, companionId = "segno") => call<SegnoMemoryView>(env, "companion-memory", { companionId }),
  file: (env: EnvironmentId | null, path: string, companionId = "segno") =>
    call<{ path: string; content: string; truncated: boolean; updatedAt: string | null }>(env, "companion-file", { companionId, path }),
  search: (env: EnvironmentId | null, query: string, companionId = "segno") =>
    call<{ results: ReadonlyArray<{ path: string; line: number; text: string }>; truncated: boolean }>(env, "companion-search", { companionId, query }),
  /** Commits in the companion's history that touched its memory, newest first. */
  changes: (env: EnvironmentId | null, options: { since?: string; limit?: number } = {}, companionId = "segno") =>
    call<{ changes: ReadonlyArray<SegnoCommit & { files: readonly string[] }> }>(env, "companion-changes", { companionId, ...options }),
  history: (env: EnvironmentId | null, path: string, companionId = "segno") =>
    call<{ path: string; commits: readonly SegnoCommit[] }>(env, "companion-history", { companionId, path }),
  diff: (env: EnvironmentId | null, path: string, sha: string, companionId = "segno") =>
    call<{ path: string; sha: string; diff: string }>(env, "companion-diff", { companionId, path, sha }),
  markSent: (env: EnvironmentId | null, itemId: string, companionId = "segno") =>
    call<{ companionId: string; itemId: string; sent: string }>(env, "companion-sent", { companionId, itemId }),
};

/** What the person sends when answering one of the companion's questions: the question quoted, then the answer. */
export function answerText(question: string, answer: string): string {
  return `${quote(question)}\n\n${answer.trim()}`;
}

/** What the person sends when asking the companion to change a line it keeps: the line quoted, then the request. */
export function changeRequestText(line: string, request: string): string {
  return `${quote(line)}\n\n${request.trim()}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export interface CompanionSender {
  /** False until the app shows the companion's conversation (it is off, or still starting). */
  readonly ready: boolean;
  readonly title: string | null;
  readonly threadId: string | null;
  /**
   * Sends `text` as the person's message in the companion's conversation and, when `itemId` names the
   * line it is about, marks that line as sent.
   */
  readonly send: (text: string, itemId?: string) => Promise<void>;
}

/** Sends the person's words into a companion's own conversation, as its room does. */
export function useCompanionSender(environmentId: EnvironmentId | null, companionId = "segno"): CompanionSender {
  const { companions } = useRubatoCompanion();
  const companion = companions.find((item) => item.id === companionId) ?? null;
  const threadId = companion?.threadId ?? null;
  const ref = useMemo(
    () => (environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, ThreadId.make(threadId)) : null),
    [environmentId, threadId],
  );
  const thread = useThreadProjection(ref)?.projection?.thread ?? null;
  const send = useCallback(
    async (text: string, itemId?: string) => {
      if (environmentId === null || thread === null)
        throw new Error(`${companion?.title ?? "Segno"} is not in the app yet. Turn it on in Settings, then try again.`);
      await run(threadEnvironment.startTurn, {
        environmentId,
        input: {
          threadId: thread.id,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          // Queued behind a turn the companion is in the middle of, started right away otherwise.
          dispatchMode: "auto",
        },
      });
      if (itemId) await rubatoSegnoMemory.markSent(environmentId, itemId, companionId).catch(() => undefined);
    },
    [environmentId, thread, companion?.title, companionId],
  );
  return { ready: thread !== null, title: companion?.title ?? null, threadId, send };
}
