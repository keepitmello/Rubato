// @effect-diagnostics nodeBuiltinImport:off
// 음성 전송의 대기 규칙을 **진짜 엔진 위에서** 확인한다. 모의 엔진이 아니라 T3의
// 커맨드 경로·영수증·턴 저장소를 지나가므로, 대화가 작업 중일 때 거부되는지와
// 그 거부가 재시도를 막지 않는지를 실제 저장 상태로 볼 수 있다.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("voice-guard-project");
const THREAD_ID = ThreadId.make("voice-guard-thread");

function makeVoiceGuardLayer() {
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "rubato-voice-guard-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function readEvents(
  runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository,
    unknown
  >,
) {
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return runtime.runPromise(
    Stream.runCollect(engine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    ),
  );
}

describe("Rubato voice turn guard", () => {
  it("refuses to send into a busy thread without consuming the command id", async () => {
    const runtime = ManagedRuntime.make(makeVoiceGuardLayer());
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const receipts = await runtime.runPromise(
      Effect.service(OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository),
    );
    const turns = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
    const voiceCommandId = CommandId.make("cmd-voice-queued");
    const voiceCommand = {
      type: "thread.turn.start",
      commandId: voiceCommandId,
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make("msg-voice-1"),
        role: "user" as const,
        text: "음성으로 보낸 첫 문장",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      onlyWhenIdle: true,
      createdAt: CREATED_AT,
    } as const;

    try {
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-voice-project"),
          projectId: PROJECT_ID,
          title: "Voice guard",
          workspaceRoot: "/tmp/voice-guard",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: CREATED_AT,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-voice-thread"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Voice guard",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: CREATED_AT,
        }),
      );

      // 평범한 클라이언트가 먼저 턴을 시작한다. 이 대화는 이제 작업 중이다.
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-typed-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("msg-typed-1"),
            role: "user",
            text: "타이핑으로 보낸 문장",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: CREATED_AT,
        }),
      );

      await expect(runtime.runPromise(engine.dispatch(voiceCommand))).rejects.toThrow(
        "RUBATO_VOICE_THREAD_BUSY",
      );

      // 거부가 영수증으로 굳으면 대기열은 영원히 다시 보낼 수 없다.
      expect(
        Option.isNone(await runtime.runPromise(receipts.getByCommandId({ commandId: voiceCommandId }))),
      ).toBe(true);

      const eventsAfterRefusal = await readEvents(runtime);
      expect(
        eventsAfterRefusal.filter((event) => event.commandId === voiceCommandId),
      ).toHaveLength(0);

      // 턴이 끝나 대기 자리가 사라지면 같은 커맨드로 다시 보낼 수 있어야 한다.
      await runtime.runPromise(turns.deletePendingTurnStartByThreadId({ threadId: THREAD_ID }));
      const sent = await runtime.runPromise(engine.dispatch(voiceCommand));
      expect(typeof sent.sequence).toBe("number");

      const eventsAfterSend = await readEvents(runtime);
      expect(
        eventsAfterSend.filter(
          (event) => event.commandId === voiceCommandId && event.type === "thread.turn-start-requested",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("sends straight through on an idle thread", async () => {
    const runtime = ManagedRuntime.make(makeVoiceGuardLayer());
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const idleThreadId = ThreadId.make("voice-guard-idle-thread");

    try {
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-voice-idle-project"),
          projectId: PROJECT_ID,
          title: "Voice guard",
          workspaceRoot: "/tmp/voice-guard-idle",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: CREATED_AT,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-voice-idle-thread"),
          threadId: idleThreadId,
          projectId: PROJECT_ID,
          title: "Idle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: CREATED_AT,
        }),
      );

      const sent = await runtime.runPromise(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-voice-idle-turn"),
          threadId: idleThreadId,
          message: {
            messageId: MessageId.make("msg-voice-idle"),
            role: "user",
            text: "한가한 대화로 보낸 문장",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          onlyWhenIdle: true,
          createdAt: CREATED_AT,
        }),
      );
      expect(typeof sent.sequence).toBe("number");
    } finally {
      await runtime.dispose();
    }
  });
});
