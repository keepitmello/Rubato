// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as RubatoStepCheckpoints from "./RubatoStepCheckpoints.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provideMerge(NodeServices.layer),
);

const WORKTREE_THREAD = ThreadId.make("thread-worktree");
const SHARED_THREAD = ThreadId.make("thread-shared-checkout");
const now = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");

/** Threads by id: only the worktree path matters here. */
const layerEngine = (
  worktrees: ReadonlyMap<ThreadId, string | null>,
  events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty,
) =>
  Layer.succeed(Orchestrator.OrchestratorV2, {
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(
        worktrees.has(threadId)
          ? ({
              id: threadId,
              worktreePath: worktrees.get(threadId) ?? null,
            } as OrchestrationV2ThreadShell)
          : null,
      ),
    streamDomainEvents: events,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);

const toolItemEvent = (input: {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly driver?: string;
  readonly status?: OrchestrationV2TurnItem["status"];
  readonly type?: "command_execution" | "file_change";
}): OrchestrationV2DomainEvent => {
  const driver = ProviderDriverKind.make(input.driver ?? "rubato-pi");
  const status = input.status ?? "completed";
  const base = {
    id: TurnItemId.make(`item-${input.toolCallId}`),
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: { driver, nativeId: input.toolCallId, strength: "strong" as const },
    parentItemId: null,
    ordinal: 0,
    status,
    title: "bash",
    startedAt: now,
    completedAt: status === "running" ? null : now,
    updatedAt: now,
  };
  const payload: OrchestrationV2TurnItem =
    input.type === "file_change"
      ? { ...base, type: "file_change", fileName: "a.txt" }
      : { ...base, type: "command_execution", input: "echo" };
  return {
    id: EventId.make(`event-${input.toolCallId}-${status}`),
    threadId: input.threadId,
    driver,
    occurredAt: now,
    type: "turn-item.updated",
    payload,
  };
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "RubatoStepCheckpoints.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    });
    return result;
  }).pipe(Effect.provide(layerVcsProcess));

const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "rubato-step-checkpoints-" });
  yield* git(cwd, ["init", "-q"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fs.writeFileString(NodePath.join(cwd, "a.txt"), "base\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-q", "-m", "initial"]);
  return cwd;
});

const refExists = (cwd: string, threadId: ThreadId, toolCallId: string) =>
  git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    RubatoStepCheckpoints.stepCheckpointRef(threadId, toolCallId),
  ]).pipe(Effect.map((result) => result.exitCode === 0));

const read = (path: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(path);
  });
const exists = (path: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(path);
  });
const write = (path: string, text: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(path, text);
  });

it.layer(layerCheckpointStore)("RubatoStepCheckpoints", (it) => {
  describe("stepCheckpointRef", () => {
    it("names the step beside the thread's turn checkpoints", () => {
      expect(RubatoStepCheckpoints.stepCheckpointRef(ThreadId.make("t"), "call-1")).toBe(
        "refs/t3/checkpoints/dA/step/Y2FsbC0x",
      );
    });
  });

  it.effect("keeps a finished Rubato step in a worktree thread and puts its files back", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const engine = layerEngine(new Map([[WORKTREE_THREAD, cwd]]));
      yield* write(NodePath.join(cwd, "a.txt"), "after step one\n");
      yield* write(NodePath.join(cwd, "made-by-step.txt"), "new\n");

      yield* RubatoStepCheckpoints.handleStepEvent(
        toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-1" }),
      ).pipe(Effect.provide(engine));
      expect(yield* refExists(cwd, WORKTREE_THREAD, "call-1")).toBe(true);

      // Later steps change the worktree; a repeated settle of step one keeps its snapshot.
      yield* write(NodePath.join(cwd, "a.txt"), "after step two\n");
      yield* write(NodePath.join(cwd, "later.txt"), "later\n");
      yield* RubatoStepCheckpoints.handleStepEvent(
        toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-1", type: "file_change" }),
      ).pipe(Effect.provide(engine));

      const restored = yield* RubatoStepCheckpoints.restoreStepCheckpoint({
        threadId: WORKTREE_THREAD,
        toolCallId: "call-1",
        cwd,
      });
      expect(restored).toBe(true);
      expect(yield* read(NodePath.join(cwd, "a.txt"))).toBe("after step one\n");
      expect(yield* read(NodePath.join(cwd, "made-by-step.txt"))).toBe("new\n");
      expect(yield* exists(NodePath.join(cwd, "later.txt"))).toBe(false);
    }),
  );

  it.effect("keeps a failed Rubato step too: it is a step the user can rewind to", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      yield* RubatoStepCheckpoints.handleStepEvent(
        toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-failed", status: "failed" }),
      ).pipe(Effect.provide(layerEngine(new Map([[WORKTREE_THREAD, cwd]]))));
      expect(yield* refExists(cwd, WORKTREE_THREAD, "call-failed")).toBe(true);
    }),
  );

  it.effect(
    "keeps nothing for another provider, a running step, or a thread without a worktree",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo;
        const engine = layerEngine(
          new Map<ThreadId, string | null>([
            [WORKTREE_THREAD, cwd],
            [SHARED_THREAD, null],
          ]),
        );
        const events = [
          toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-codex", driver: "codex" }),
          toolItemEvent({
            threadId: WORKTREE_THREAD,
            toolCallId: "call-running",
            status: "running",
          }),
          toolItemEvent({ threadId: SHARED_THREAD, toolCallId: "call-shared" }),
        ];
        for (const event of events) {
          yield* RubatoStepCheckpoints.handleStepEvent(event).pipe(Effect.provide(engine));
        }
        expect(yield* refExists(cwd, WORKTREE_THREAD, "call-codex")).toBe(false);
        expect(yield* refExists(cwd, WORKTREE_THREAD, "call-running")).toBe(false);
        expect(yield* refExists(cwd, SHARED_THREAD, "call-shared")).toBe(false);
        expect(
          RubatoStepCheckpoints.stepCompletionOf(
            toolItemEvent({ threadId: SHARED_THREAD, toolCallId: "call-shared" }),
          ),
        ).toEqual({ threadId: SHARED_THREAD, toolCallId: "call-shared" });
      }),
  );

  it.effect("answers false when the step has no snapshot", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      yield* write(NodePath.join(cwd, "a.txt"), "untouched\n");
      const restored = yield* RubatoStepCheckpoints.restoreStepCheckpoint({
        threadId: WORKTREE_THREAD,
        toolCallId: "call-missing",
        cwd,
      });
      expect(restored).toBe(false);
      expect(yield* read(NodePath.join(cwd, "a.txt"))).toBe("untouched\n");
    }),
  );

  it.effect("a capture that fails only warns, and later steps still get kept", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const fs = yield* FileSystem.FileSystem;
      const notARepo = yield* fs.makeTempDirectoryScoped({ prefix: "rubato-step-not-git-" });
      const engine = layerEngine(
        new Map<ThreadId, string | null>([
          [SHARED_THREAD, notARepo],
          [WORKTREE_THREAD, cwd],
        ]),
      );
      yield* RubatoStepCheckpoints.handleStepEvent(
        toolItemEvent({ threadId: SHARED_THREAD, toolCallId: "call-broken" }),
      ).pipe(Effect.provide(engine));
      yield* RubatoStepCheckpoints.handleStepEvent(
        toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-after" }),
      ).pipe(Effect.provide(engine));
      expect(yield* refExists(cwd, WORKTREE_THREAD, "call-after")).toBe(true);
    }),
  );

  it.effect("the layer follows the orchestrator's live events", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const drained = yield* Deferred.make<void>();
      const events = Stream.concat(
        Stream.fromIterable([
          toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-live" }),
          toolItemEvent({ threadId: WORKTREE_THREAD, toolCallId: "call-other", driver: "codex" }),
        ]),
        Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain),
      );
      yield* Effect.scoped(
        Layer.build(
          RubatoStepCheckpoints.layer.pipe(
            Layer.provide(layerEngine(new Map([[WORKTREE_THREAD, cwd]]), events)),
          ),
        ).pipe(Effect.andThen(Deferred.await(drained))),
      );
      expect(yield* refExists(cwd, WORKTREE_THREAD, "call-live")).toBe(true);
      expect(yield* refExists(cwd, WORKTREE_THREAD, "call-other")).toBe(false);
    }),
  );
});
