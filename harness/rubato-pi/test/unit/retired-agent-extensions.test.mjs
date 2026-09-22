import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_SHIM_BANNER, removeRetiredAgentExtensions } from "../../src/retired-agent-extensions.mjs";

test("a leftover senpi-era shim is removed; the user's own extensions stay", () => {
  // The shim re-exported a module that no longer exists, and stock pi loads every file here,
  // so leaving it made every session exit at extension load (2026-09-23).
  const agentDir = mkdtempSync(join(tmpdir(), "retired-ext-"));
  const dir = join(agentDir, "extensions");
  mkdirSync(dir);
  writeFileSync(join(dir, "tps.js"), `${RETIRED_SHIM_BANNER}\nexport { default } from "file:///gone/tps.mjs";\n`);
  writeFileSync(join(dir, "mine.js"), "export default function mine() {}\n");
  const removed = removeRetiredAgentExtensions(agentDir);
  assert.deepEqual(removed, [join(dir, "tps.js")]);
  assert.deepEqual(readdirSync(dir), ["mine.js"]);
  assert.deepEqual(removeRetiredAgentExtensions(join(agentDir, "missing")), []);
});
