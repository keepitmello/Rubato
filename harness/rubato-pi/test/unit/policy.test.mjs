import test from "node:test";
import assert from "node:assert/strict";
import {
  DAG_RUBATO_OWNED_COMPONENTS,
  RUBATO_OWNED_COMPONENTS,
  selectComponents,
  unexpectedComponents,
} from "../../src/policy.mjs";

test("selects the four Rubato-owned components and drops the rest", () => {
  const selected = selectComponents(
    [
      { name: "native-badge" },
      { name: "task" },
      { name: "memory" },
      { name: "ast-grep" },
      { name: "unknown-future" },
    ],
    RUBATO_OWNED_COMPONENTS,
  );
  assert.deepEqual(
    selected.map((c) => c.name),
    ["task", "memory", "ast-grep"],
  );
});

test("DAG allowlist is the Rubato-owned set without task", () => {
  assert.ok(!DAG_RUBATO_OWNED_COMPONENTS.includes("task"));
  assert.deepEqual(
    [...DAG_RUBATO_OWNED_COMPONENTS],
    ["ast-grep", "lsp", "memory"],
  );
});

test("new upstream component names are unexpected until decided", () => {
  assert.deepEqual(unexpectedComponents(["task", "new-thing"]), ["new-thing"]);
});
