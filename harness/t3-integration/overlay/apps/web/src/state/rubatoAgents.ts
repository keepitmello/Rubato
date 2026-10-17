import type { EnvironmentId, ToolLifecycleItemType } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server for the Agents panel (src/agents/service.mjs). */
const AGENTS_ROUTE = "/rubato/agents";

/**
 * One piece of a child agent's conversation, in the order it happened. `at` is the epoch
 * time of the entry it came from; pieces of one model message share `message`. `writing`
 * marks the message the agent is still writing, which its session file does not hold yet.
 */
export type AgentTranscriptItem =
  | { readonly kind: "user"; readonly text: string; readonly at?: number }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly message: number;
      readonly at?: number;
      readonly writing?: boolean;
    }
  | {
      readonly kind: "thinking";
      readonly text: string;
      readonly message: number;
      readonly at?: number;
      readonly writing?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      /** The item type and row title the lead's thread gives the same call. */
      readonly itemType: ToolLifecycleItemType;
      readonly title: string;
      readonly detail?: string;
      readonly input: string;
      readonly output?: string;
      readonly isError?: boolean;
      readonly message: number;
      readonly at?: number;
      readonly writing?: boolean;
    }
  | { readonly kind: "compaction"; readonly text: string; readonly at?: number }
  | {
      readonly kind: "error";
      readonly text: string;
      readonly message: number;
      readonly at?: number;
      readonly writing?: boolean;
    };

export interface AgentTranscript {
  /** False when the agent left no session file (a team row, or a child that never started). */
  readonly found: boolean;
  /** Names the files read; sent back so an unchanged transcript is not sent again. */
  readonly version: string;
  /** Absent when `unchanged`. */
  readonly items?: ReadonlyArray<AgentTranscriptItem>;
  readonly unchanged?: boolean;
  /** For a working agent asked with `live`: the message it is writing now, after `items`. */
  readonly writing?: ReadonlyArray<AgentTranscriptItem>;
  /** Whether the thread's session is attached, so the agent can be stopped or messaged. */
  readonly controllable: boolean;
}

export interface AgentTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  /** The directory the thread's session runs in; its children's files live under it. */
  readonly cwd: string;
  readonly taskId: string;
}

/** `live` also asks for the message a working agent is writing now. */
export function readAgentTranscript(
  target: AgentTarget,
  version?: string,
  live = false,
): Promise<AgentTranscript> {
  const { environmentId, ...body } = target;
  return postRubato<AgentTranscript>(
    environmentId,
    AGENTS_ROUTE,
    "transcript",
    { ...body, ...(version ? { version } : {}), ...(live ? { live } : {}) },
    "agent sessions",
  );
}

/**
 * The file's items, then the message being written, numbered after the file's last message
 * so the finished message takes its place when it lands.
 */
export function withWriting(
  items: ReadonlyArray<AgentTranscriptItem>,
  writing: ReadonlyArray<AgentTranscriptItem> | undefined,
): ReadonlyArray<AgentTranscriptItem> {
  if (!writing || writing.length === 0) return items;
  let next = 0;
  for (const item of items) if ("message" in item) next = Math.max(next, item.message + 1);
  return [...items, ...writing.map((item) => ("message" in item ? { ...item, message: next } : item))];
}

export function stopAgent({
  environmentId,
  threadId,
  taskId,
}: AgentTarget): Promise<{ outcome: string }> {
  return postRubato(environmentId, AGENTS_ROUTE, "stop", { threadId, taskId }, "agent sessions");
}

export function messageAgent(
  { environmentId, threadId, taskId }: AgentTarget,
  message: string,
): Promise<{ outcome: string }> {
  return postRubato(
    environmentId,
    AGENTS_ROUTE,
    "send",
    { threadId, taskId, message },
    "agent sessions",
  );
}
