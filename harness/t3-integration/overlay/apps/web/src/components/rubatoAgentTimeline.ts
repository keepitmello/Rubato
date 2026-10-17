/**
 * A child agent's conversation in the shapes the lead's own thread is drawn from, so the
 * Agents panel paints it with the same timeline (MessagesTimeline): thoughts and tool calls
 * fold the same way, words read at the same size. The rows are V2 turn items as the Pi
 * adapter makes them for the lead (packages/provider-pi adapter.ts): bash is a command,
 * edit and write a file change, anything else a tool call; one run per message the agent
 * was sent.
 */
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import type { TimelineEntry } from "../session-logic";
import type { AgentTranscriptItem } from "../state/rubatoAgents";
import type { TimelineLatestRun } from "./chat/MessagesTimeline.logic";

export interface AgentTimeline {
  readonly entries: TimelineEntry[];
  readonly latestRun: TimelineLatestRun | null;
  readonly runningRunId: RunId | null;
  readonly activeTurnStartedAt: string | null;
}

interface Run {
  readonly id: RunId;
  readonly startedAt: string;
  lastAt: string;
}

const parse = (input: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(input);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const text = (record: Record<string, unknown> | null, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export function agentTimeline(
  items: ReadonlyArray<AgentTranscriptItem>,
  { taskId, live }: { taskId: string; live: boolean },
): AgentTimeline {
  const threadId = ThreadId.make(`agent:${taskId}`);
  const turnItems: OrchestrationV2TurnItem[] = [];
  const runs: Run[] = [];
  // Rows order by time, and pieces of one message share a timestamp; every piece takes
  // the next millisecond so the file order holds.
  let clock = 0;
  const stamp = (at: number | undefined) => {
    clock = Math.max(clock + 1, at ?? 0);
    return new Date(clock).toISOString();
  };
  const runAt = (createdAt: string): Run => {
    let run = runs.at(-1);
    if (!run) {
      run = { id: RunId.make(`agent-run:${taskId}:0`), startedAt: createdAt, lastAt: createdAt };
      runs.push(run);
    }
    run.lastAt = createdAt;
    return run;
  };
  const base = (id: string, createdAt: string, runId: RunId | null, done: boolean) => {
    const at = DateTime.makeUnsafe(createdAt);
    return {
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: turnItems.length,
      title: null,
      startedAt: at,
      completedAt: done ? at : null,
      updatedAt: at,
    } as const;
  };
  // One answer and one thought per model message, as the adapter streams them.
  const said = new Map<string, number>();
  // A message still being written streams, as the lead's own reply does while it comes in.
  const say = (type: "assistant_message" | "reasoning", key: string, body: string, createdAt: string, writing: boolean) => {
    const held = said.get(key);
    const run = runAt(createdAt);
    if (held !== undefined) {
      const previous = turnItems[held]!;
      if (previous.type === "assistant_message" || previous.type === "reasoning") {
        turnItems[held] = { ...previous, text: `${previous.text}\n\n${body}`, updatedAt: DateTime.makeUnsafe(createdAt) };
      }
      return;
    }
    said.set(key, turnItems.length);
    const status = writing ? "running" : "completed";
    turnItems.push(
      type === "assistant_message"
        ? { ...base(key, createdAt, run.id, !writing), status, type, messageId: MessageId.make(key), text: body, streaming: writing }
        : { ...base(key, createdAt, run.id, !writing), status, type, text: body, streaming: writing },
    );
  };

  for (const [index, item] of items.entries()) {
    const createdAt = stamp(item.at);
    switch (item.kind) {
      case "user": {
        const run = { id: RunId.make(`agent-run:${taskId}:${runs.length + 1}`), startedAt: createdAt, lastAt: createdAt };
        runs.push(run);
        const id = `agent-user:${taskId}:${index}`;
        turnItems.push({
          ...base(id, createdAt, run.id, true),
          status: "completed",
          type: "user_message",
          createdBy: "user",
          creationSource: "server",
          messageId: MessageId.make(id),
          inputIntent: "turn_start",
          text: item.text,
          attachments: [],
        });
        break;
      }
      case "assistant":
        say("assistant_message", `agent-assistant:${taskId}:${item.message}`, item.text, createdAt, item.writing === true);
        break;
      case "thinking":
        say("reasoning", `agent-reasoning:${taskId}:${item.message}`, item.text, createdAt, item.writing === true);
        break;
      case "tool": {
        const done = item.output !== undefined;
        const status = !done ? "running" : item.isError ? "failed" : "completed";
        const shared = { ...base(`agent-tool:${taskId}:${item.id || index}`, createdAt, runAt(createdAt).id, done), status, title: item.name } as const;
        const args = parse(item.input);
        if (item.name === "bash" || item.name === "powershell") {
          turnItems.push({
            ...shared,
            type: "command_execution",
            input: text(args, "command") ?? item.input,
            ...(item.output ? { output: item.output } : {}),
            ...(item.isError ? { outputIndicatesFailure: true } : {}),
          });
          break;
        }
        const fileName = item.name === "edit" || item.name === "write" ? (text(args, "path") ?? text(args, "file_path")) : undefined;
        if (fileName !== undefined) {
          const newStr = item.name === "write" ? text(args, "content") : undefined;
          turnItems.push({
            ...shared,
            type: "file_change",
            fileName,
            ...(newStr === undefined ? {} : { newStr }),
            ...(item.isError && item.output ? { diffStr: item.output } : {}),
          });
          break;
        }
        turnItems.push({
          ...shared,
          type: "dynamic_tool",
          toolName: item.name,
          input: args ?? item.input,
          ...(item.output === undefined ? {} : { output: item.output }),
        });
        break;
      }
      case "compaction":
        turnItems.push({
          ...base(`agent-compaction:${taskId}:${index}`, createdAt, runAt(createdAt).id, true),
          status: "completed",
          type: "system_notice",
          message: "Context compacted",
        });
        break;
      case "error":
        turnItems.push({
          ...base(`agent-error:${taskId}:${index}`, createdAt, runAt(createdAt).id, true),
          status: "completed",
          type: "system_notice",
          message: item.text,
        });
        break;
    }
  }

  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = turnItems.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));
  const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems, optimisticMessages: [] });
  const last = runs.at(-1);
  if (!last) return { entries, latestRun: null, runningRunId: null, activeTurnStartedAt: null };
  return {
    entries,
    latestRun: {
      runId: last.id,
      status: live ? "running" : "completed",
      startedAt: last.startedAt,
      completedAt: live ? null : last.lastAt,
    },
    runningRunId: live ? last.id : null,
    activeTurnStartedAt: live ? last.startedAt : null,
  };
}
