import type { EnvironmentId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server for the Agents panel (src/agents/service.mjs). */
const AGENTS_ROUTE = "/rubato/agents";

/** One piece of a child agent's conversation, in the order it happened. */
export type AgentTranscriptItem =
  | { readonly kind: "user"; readonly text: string; readonly at?: number }
  | { readonly kind: "assistant"; readonly text: string; readonly at?: number }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly input: string;
      readonly output?: string;
      readonly isError?: boolean;
      readonly at?: number;
    }
  | { readonly kind: "compaction"; readonly text: string; readonly at?: number }
  | { readonly kind: "error"; readonly text: string };

export interface AgentTranscript {
  /** False when the agent left no session file (a team row, or a child that never started). */
  readonly found: boolean;
  /** Names the files read; sent back so an unchanged transcript is not sent again. */
  readonly version: string;
  /** Absent when `unchanged`. */
  readonly items?: ReadonlyArray<AgentTranscriptItem>;
  readonly unchanged?: boolean;
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

export function readAgentTranscript(
  target: AgentTarget,
  version?: string,
): Promise<AgentTranscript> {
  const { environmentId, ...body } = target;
  return postRubato<AgentTranscript>(
    environmentId,
    AGENTS_ROUTE,
    "transcript",
    { ...body, ...(version ? { version } : {}) },
    "agent sessions",
  );
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
