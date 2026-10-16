// legacy-import-edits.mjs: a V1 bridge bug stored a reply's thinking as an assistant
// message whose id ends `:reasoning`; it must not come back as an answer.
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));
const layerTest = Layer.mergeAll(
  layerStores,
  layerEventSink,
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerEventSink))),
);

it.layer(layerTest)("Rubato legacy import", (it) => {
  it.effect("leaves V1 thinking stored as an assistant message out of the thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:rubato-reasoning");
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project:rubato', 'Rubato', '/tmp/rubato', '{"instanceId":"rubato","model":"xai/grok-4.7"}',
          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at, deleted_at)
        VALUES (${threadId}, 'project:rubato', 'Thinking twice', '{"instanceId":"rubato","model":"xai/grok-4.7"}',
          'full-access', 'default', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:04.000Z', NULL, NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at)
        VALUES
          ('message:user:1', ${threadId}, NULL, 'user', 'Why?', '[]', 0,
            '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
          ('assistant:pi:session-1:aaaaaaaaaaaaaaaaaaaaaaaa:reasoning', ${threadId}, NULL, 'assistant',
            'Let me think about why.', '[]', 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
          ('assistant:pi:session-1:aaaaaaaaaaaaaaaaaaaaaaaa', ${threadId}, NULL, 'assistant',
            'Because.', '[]', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
          ('assistant:pi:session-1:bbbbbbbbbbbbbbbbbbbbbbbb:reasoning', ${threadId}, NULL, 'assistant',
            'Trailing thought.', '[]', 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z')
      `;

      yield* importer.reconcileShells;
      const shell = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(shell.messages.map((message) => message.text), ["Why?", "Because."]);

      yield* importer.ensureTranscript(threadId);
      const full = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(full.messages.map((message) => message.text), ["Why?", "Because."]);
    }),
  );
});
