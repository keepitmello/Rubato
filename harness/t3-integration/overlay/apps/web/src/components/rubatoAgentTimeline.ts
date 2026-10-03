/**
 * A child agent's conversation in the shapes the lead's own thread is drawn from, so the
 * Agents panel paints it with the same timeline (MessagesTimeline): thoughts and tool calls
 * fold the same way, words read at the same size. The rows are what the T3 server keeps of
 * the lead's Pi session (src/events.mjs → ProviderRuntimeIngestion): Pi message ids, tool
 * activities with the bridge's item type and title, one turn per message the agent was sent.
 */
import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveTimelineEntries, deriveWorkLogEntries, type TimelineEntry } from "../session-logic";
import type { ChatMessage } from "../types";
import type { AgentTranscriptItem } from "../state/rubatoAgents";
import type { TimelineLatestTurn } from "./chat/MessagesTimeline.logic";

export interface AgentTimeline {
  readonly entries: TimelineEntry[];
  readonly latestTurn: TimelineLatestTurn | null;
  readonly runningTurnId: TurnId | null;
  readonly activeTurnStartedAt: string | null;
}

interface Turn {
  readonly id: TurnId;
  readonly startedAt: string;
  lastAt: string;
}

/** The Pi message key the bridge stamps on a message's answer and thought ids. */
const piKey = (taskId: string, message: number) =>
  `${taskId}:${message.toString(16).padStart(24, "0")}`;

export function agentTimeline(
  items: ReadonlyArray<AgentTranscriptItem>,
  { taskId, live }: { taskId: string; live: boolean },
): AgentTimeline {
  const messages: ChatMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const turns: Turn[] = [];
  // Entries order by time, and pieces of one message share a timestamp; every piece takes
  // the next millisecond so the file order holds.
  let clock = 0;
  const stamp = (at: number | undefined) => {
    clock = Math.max(clock + 1, at ?? 0);
    return new Date(clock).toISOString();
  };
  const turnAt = (createdAt: string): Turn => {
    let turn = turns.at(-1);
    if (!turn) {
      turn = { id: TurnId.make(`agent-turn:${taskId}:0`), startedAt: createdAt, lastAt: createdAt };
      turns.push(turn);
    }
    turn.lastAt = createdAt;
    return turn;
  };
  // One answer and one thought per model message, as the bridge streams them.
  const said = new Map<string, ChatMessage>();
  const say = (role: "assistant" | "reasoning", id: string, text: string, createdAt: string) => {
    const held = said.get(id);
    if (held) {
      const next = { ...held, text: `${held.text}\n\n${text}`, updatedAt: createdAt };
      messages[messages.indexOf(held)] = next;
      said.set(id, next);
      turnAt(createdAt);
      return;
    }
    const message: ChatMessage = {
      id: MessageId.make(id),
      role,
      text,
      turnId: turnAt(createdAt).id,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    };
    messages.push(message);
    said.set(id, message);
  };
  const act = (
    id: string,
    createdAt: string,
    activity: Pick<OrchestrationThreadActivity, "kind" | "tone" | "summary" | "payload">,
  ) => {
    activities.push({
      ...activity,
      id: EventId.make(id),
      turnId: turnAt(createdAt).id,
      sequence: activities.length,
      createdAt,
    });
  };

  for (const [index, item] of items.entries()) {
    const createdAt = stamp(item.at);
    switch (item.kind) {
      case "user":
        turns.push({
          id: TurnId.make(`agent-turn:${taskId}:${turns.length + 1}`),
          startedAt: createdAt,
          lastAt: createdAt,
        });
        messages.push({
          id: MessageId.make(`agent-user:${taskId}:${index}`),
          role: "user",
          text: item.text,
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        });
        break;
      case "assistant":
        say("assistant", `assistant:pi:${piKey(taskId, item.message)}`, item.text, createdAt);
        break;
      case "thinking":
        say(
          "reasoning",
          `reasoning:raw:pi:${piKey(taskId, item.message)}:reasoning`,
          item.text,
          createdAt,
        );
        break;
      case "tool": {
        const running = item.output === undefined;
        act(`agent-tool:${taskId}:${item.id || index}`, createdAt, {
          kind: running ? "tool.updated" : "tool.completed",
          tone: "tool",
          summary: item.title,
          payload: {
            itemType: item.itemType,
            toolCallId: `pi-tool:${taskId}:${item.id}`,
            status: running ? "inProgress" : item.isError ? "failed" : "completed",
            title: item.title,
            ...(item.detail ? { detail: item.detail } : {}),
            data: running
              ? { toolCallId: item.id }
              : { content: [{ type: "text", text: item.output }], toolCallId: item.id },
          },
        });
        break;
      }
      case "compaction":
        act(`agent-compaction:${taskId}:${index}`, createdAt, {
          kind: "context-compaction",
          tone: "info",
          summary: "Context compacted",
          payload: { state: "compacted" },
        });
        break;
      case "error":
        act(`agent-error:${taskId}:${index}`, createdAt, {
          kind: "runtime.error",
          tone: "error",
          summary: "Runtime error",
          payload: { message: item.text },
        });
        break;
    }
  }

  const entries = deriveTimelineEntries(messages, [], deriveWorkLogEntries(activities));
  const last = turns.at(-1);
  if (!last) return { entries, latestTurn: null, runningTurnId: null, activeTurnStartedAt: null };
  return {
    entries,
    latestTurn: {
      turnId: last.id,
      state: live ? "running" : "completed",
      startedAt: last.startedAt,
      completedAt: live ? null : last.lastAt,
    },
    runningTurnId: live ? last.id : null,
    activeTurnStartedAt: live ? last.startedAt : null,
  };
}
