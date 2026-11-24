import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { readPrompt } from "./agyPrompt.mjs";

export class AgyPromptFileError extends Schema.TaggedError<AgyPromptFileError>()("AgyPromptFileError", { cause: Schema.Defect() }) {}

// Native and portable forks both commit this app-thread lineage before opening
// the target session. A native agy session id and a Google login are not part of it.
export const agyThreadPrompt = Effect.fn("Rubato.agyThreadPrompt")(function* (
  sql: SqlClient.SqlClient, state: string, thread: string,
) {
  const seen = new Set<string>();
  let id: string | null = thread;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const current = id;
    const choice = yield* Effect.tryPromise({ try: () => readPrompt(state, current), catch: (cause) => new AgyPromptFileError({ cause }) });
    if (choice) return choice;
    const rows: ReadonlyArray<{ parent: string | null }> = yield* sql<{ parent: string | null }>`
      SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent
      FROM orchestration_v2_projection_threads WHERE thread_id = ${current}
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'fork'`;
    id = rows[0]?.parent ?? null;
  }
  return null;
});
