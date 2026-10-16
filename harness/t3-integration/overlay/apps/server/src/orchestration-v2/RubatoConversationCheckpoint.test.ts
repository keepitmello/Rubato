// rewind-edits.mjs: in a workspace that is not a git repository a turn still leaves a
// checkpoint the conversation can rewind to; restoring it leaves the files alone.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const scope: OrchestrationV2CheckpointScope = {
  id: CheckpointScopeId.make("checkpoint-scope:plain-folder"),
  threadId: ThreadId.make("thread:plain-folder"),
  runId: RunId.make("run:plain-folder:1"),
  nodeId: NodeId.make("node:plain-folder:1"),
  parentScopeId: null,
  providerThreadId: ProviderThreadId.make("provider-thread:plain-folder"),
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: "/tmp/plain-folder",
  createdAt: DateTime.makeUnsafe("2026-10-16T00:00:00.000Z"),
};
const touched: Array<string> = [];
const layerTest = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: () => Effect.succeed(false),
        hasCheckpointRef: () => Effect.sync(() => { touched.push("hasCheckpointRef"); return false; }),
        captureCheckpoint: () => Effect.sync(() => { touched.push("captureCheckpoint"); }),
        restoreCheckpoint: () => Effect.sync(() => { touched.push("restoreCheckpoint"); return false; }),
        deleteCheckpointRefs: () => Effect.sync(() => { touched.push("deleteCheckpointRefs"); }),
      }),
    ),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("a plain folder's turns leave conversation checkpoints that restore without touching files", () =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 0 });
    const turn = yield* checkpoints.capture({
      scope, ordinalWithinScope: 1, runId: scope.runId!, nodeId: scope.nodeId!, appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    });
    assert.equal(baseline.status, "ready");
    assert.equal(turn.status, "ready");
    assert.deepStrictEqual(turn.files, []);
    yield* checkpoints.restore({ scope, checkpoint: baseline });
    yield* checkpoints.deleteStaleRefs({ scope, checkpoints: [turn] });
    assert.deepStrictEqual(touched, []);
  }).pipe(Effect.provide(layerTest)),
);
