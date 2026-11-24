// @effect-diagnostics nodeBuiltinImport:off -- the test owns a temporary prompt directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "vite-plus/test";
import { agyThreadPrompt } from "./RubatoAgyThreadPrompt.ts";
import { savePrompt } from "./agyPrompt.mjs";

it("uses app-thread ancestry for native and portable forks, not Google accounts or native session IDs", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "agy-forks-"));
  try {
    await savePrompt(state, "original", { text: "Only this.", label: "Memo" });
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, payload_json TEXT)`;
      for (const [id, parent, relationship] of [
        ["native", "original", "fork"], ["portable", "native", "fork"],
        ["child", "original", "subagent"], ["cycle", "cycle", "fork"],
      ] as const) {
        const payload = JSON.stringify({ lineage: { parentThreadId: parent, relationshipToParent: relationship } });
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${payload})`;
      }
      for (const id of ["original", "native", "portable"]) {
        expect(yield* agyThreadPrompt(sql, state, id)).toMatchObject({ text: "Only this.", label: "Memo" });
      }
      for (const id of ["unrelated", "child", "cycle"]) expect(yield* agyThreadPrompt(sql, state, id)).toBeNull();
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))));
  } finally { await rm(state, { recursive: true, force: true }); }
});
