import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("compaction inherits the session reasoning settings", () => {
  const source = readFileSync(
    join(import.meta.dir, "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/speculative.js"),
    "utf8",
  );
  expect(source).not.toContain("summarizationReasoningOptions");
  expect(source).not.toContain("thinkingEnabled: false");
  expect(source).not.toContain("reasoningSummary: null");
});
