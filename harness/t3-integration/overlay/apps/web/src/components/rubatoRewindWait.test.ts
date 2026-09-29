import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import type { Thread } from "../types";
import { waitForRevertedMessage } from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: threadId,
  environmentId,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("rubato"), model: "m" },
  runtimeMode: "full-access",
  interactionMode: "default",
  session: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  pullRequests: [],
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  ...overrides,
});
const checkpoint = (turnId: string, checkpointTurnCount: number) => ({
  turnId: TurnId.make(turnId),
  checkpointTurnCount,
  checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${turnId}`),
  status: "ready" as const,
  files: [],
  assistantMessageId: null,
  completedAt: now,
});
const turn = (turnId: string) => ({
  turnId: TurnId.make(turnId),
  state: "completed" as const,
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  assistantMessageId: null,
});

describe("waitForRevertedMessage with a Rubato child still running", () => {
  const message = {
    id: MessageId.make("rewound-message"),
    role: "user" as const,
    text: "edit this question",
    turnId: null,
    createdAt: now,
    updatedAt: now,
    streaming: false,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("finishes when a child wakes the rewound thread before the request is acknowledged", async () => {
    vi.useFakeTimers();
    const atom = Atom.make<Thread | null>(
      thread({ messages: [message], checkpoints: [checkpoint("kept", 1), checkpoint("rewound", 2)], latestTurn: turn("rewound") }),
    );
    vi.spyOn(environmentThreadDetails, "detailAtom").mockReturnValue(atom);
    const result = waitForRevertedMessage({ environmentId, threadId }, message.id, 1, async () => {
      // thread.reverted lands, then the child's completion opens a new turn, all before the ack.
      appAtomRegistry.set(atom, thread({ checkpoints: [checkpoint("kept", 1)], latestTurn: turn("kept") }));
      appAtomRegistry.set(
        atom,
        thread({ checkpoints: [checkpoint("kept", 1), checkpoint("woken", 2)], latestTurn: turn("woken") }),
      );
    }, 20);
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(undefined);
  });

  it("keeps waiting while the rewound turn is still there", async () => {
    vi.useFakeTimers();
    const atom = Atom.make<Thread | null>(
      thread({ messages: [message], checkpoints: [checkpoint("kept", 1), checkpoint("rewound", 2)] }),
    );
    vi.spyOn(environmentThreadDetails, "detailAtom").mockReturnValue(atom);
    const result = waitForRevertedMessage({ environmentId, threadId }, message.id, 1, async () => {
      appAtomRegistry.set(atom, thread({ checkpoints: [checkpoint("kept", 1), checkpoint("rewound", 2)] }));
    }, 20);
    const rejection = expect(result).rejects.toThrow("Timed out waiting for the thread to rewind.");
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
  });
});
