// The step-rewind route's order of effects (RubatoStepRewind.ts): nothing changes unless the
// engine still holds the step, files go back before the engine rewinds, and only the continue
// route's own message becomes the engine's continue. Engine and session lookup are stubs; the
// HTTP handling, authorization, branches and side effects are the route's own.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AuthOrchestrationOperateScope, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { RubatoThreadImporter } from "./provider/RubatoThreadImporter.ts";
import { rubatoStepRewindRouteLayer } from "./RubatoStepRewind.ts";

const state = vi.hoisted(() => ({
  engineCut: false, nativeStepMissing: false, marks: [] as string[],
}));
vi.mock("./provider/RubatoPiSessions.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    piSessionOfThread: () => Effect.succeed({ sessionId: "native-same-session" }),
    rubatoBridge: () => Effect.succeed({
      async stepBatch() {
        if (state.nativeStepMissing) throw new Error("This step is not on the conversation's current branch");
        return ["first-call"];
      },
      markStepContinue(threadId: string) { state.marks.push(`mark:${threadId}`); },
      async rewindToStep() {
        if (state.nativeStepMissing) throw new Error("This step is not on the conversation's current branch");
        state.engineCut = true;
        return { batch: ["first-call"] };
      },
      stepContinueText: "continue words",
    }),
  };
});
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

function fixture(options: { runStatus?: string; status?: string; later?: boolean; fileError?: boolean; nativeStepMissing?: boolean } = {}) {
  state.engineCut = false;
  state.nativeStepMissing = options.nativeStepMissing ?? false;
  state.marks = [];
  const effects: string[] = [];
  const run = { id: "run-one", threadId: "thread-one", ordinal: 1, status: options.runStatus ?? "completed",
    providerInstanceId: "rubato", checkpointId: "checkpoint-one" };
  const later = { ...run, id: "run-two", ordinal: 2 };
  const tool = { id: "item-one", threadId: run.threadId, runId: run.id, type: "command_execution",
    status: options.status ?? "completed", ordinal: 2,
    nativeItemRef: { driver: "rubato-pi", nativeId: "first-call" } };
  const projection = {
    runs: options.later ? [run, later] : [run],
    turnItems: [tool, { id: "after", threadId: run.threadId, runId: run.id,
      type: "assistant_message", status: "completed", ordinal: 3, messageId: "answer" }],
    messages: [{ id: "answer", threadId: run.threadId, runId: run.id, role: "assistant", text: "after step" }],
    checkpoints: [{ id: "checkpoint-one", scopeId: "scope-one", ref: "refs/test/one" }],
  };
  const engine = {
    getThreadRecords: () => Effect.succeed(projection),
    getThreadShell: () => Effect.succeed({ id: run.threadId, worktreePath: options.fileError ? "/unused-worktree" : null }),
    dispatch: (command: { type: string; text?: string }) => Effect.sync(() => {
      if (command.type === "message.dispatch") { effects.push(...state.marks.splice(0), `sent:${command.text}`); return; }
      effects.push("later-turns-rolled-back"); later.status = "rolled_back";
    }),
  };
  const layers = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(EnvironmentAuth, {
      authenticateHttpRequest: () => Effect.succeed({ sessionId: AuthSessionId.make("test"),
        subject: "test", method: "bearer-access-token", scopes: [AuthOrchestrationOperateScope] }),
    } as unknown as EnvironmentAuth["Service"]),
    Layer.succeed(Orchestrator.OrchestratorV2, engine as unknown as Orchestrator.OrchestratorV2["Service"]),
    Layer.succeed(RubatoThreadImporter, {
      cutRun: () => Effect.sync(() => { effects.push("projection-cut"); return "cut-run"; }),
    } as unknown as RubatoThreadImporter["Service"]),
    Layer.succeed(SqlClient.SqlClient, {} as never),
    Layer.succeed(ProviderInstanceRegistry, {} as ProviderInstanceRegistry["Service"]),
    Layer.succeed(CheckpointStore.CheckpointStore, {
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => options.fileError
        ? Effect.fail({ _tag: "CheckpointUnavailable", message: "worktree unavailable" } as never) : Effect.succeed(true),
    } as unknown as CheckpointStore.CheckpointStore["Service"]),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    rubatoStepRewindRouteLayer.pipe(Layer.provideMerge(layers)), { disableLogger: true },
  );
  disposers.push(dispose);
  const post = (route: string, body: unknown) => handler(new Request(`http://fixture${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { effects, projection, post, request: () => handler(new Request("http://fixture/rubato/step-rewind", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: run.threadId, itemId: tool.id, restoreFiles: options.fileError ?? false }),
  })) };
}
it("a completed tool cuts both the engine and displayed rows", async () => {
  const f = fixture();
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(state.engineCut).toBe(true);
  expect(f.effects).toEqual(["projection-cut"]);
  expect(((await response.json()) as { error: { code: string }; hiddenItemIds: string[] }).hiddenItemIds).toEqual(["after"]);
});
it("a failed but finished tool is still a step to rewind to", async () => {
  const f = fixture({ status: "failed" });
  const response = await f.request();
  expect({ status: response.status, body: (await response.json()) as unknown }).toMatchObject({ status: 200 });
});
it("a file restore error does not leave the native history cut while T3 still shows the old suffix", async () => {
  const f = fixture({ fileError: true });
  const response = await f.request();
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: { code: string }; hiddenItemIds: string[] }).error.code).toBe("files-failed");
  expect({ engineCut: state.engineCut, projectionCut: f.effects.includes("projection-cut") })
    .toEqual({ engineCut: false, projectionCut: false });
});
it("a stale step is validated before deleting newer turns", async () => {
  const f = fixture({ later: true, nativeStepMissing: true });
  const response = await f.request();
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: { code: string }; hiddenItemIds: string[] }).error.code).toBe("engine-refused");
  expect(f.effects).toEqual([]);
});
it("the continue route marks the thread right before it sends the continue words", async () => {
  const f = fixture({ runStatus: "interrupted" });
  const response = await f.post("/rubato/step-rewind/continue", { threadId: "thread-one" });
  expect(response.status).toBe(200);
  expect(f.effects).toEqual(["mark:thread-one", "sent:continue words"]);
});
