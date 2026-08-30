import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { probeRpc } from "../helpers/rpc-surface.mjs";

test("memory stays ON and records that token logs need a real model turn", { timeout: 60_000 }, async () => {
  const surface = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
  });
  for (const name of ["memory", "dream", "palace"]) {
    assert.ok(surface.extensionCommands.includes(name), `missing ${name}`);
  }
  const note = {
    measuredAt: new Date().toISOString(),
    memoryCommands: ["memory", "dream", "palace"].filter((name) =>
      surface.extensionCommands.includes(name),
    ),
    promptTokens: null,
    cacheKinds: null,
    reason: "no model turn in this probe; record tokens on smoke:real",
  };
  const tmp = join(dirname(fileURLToPath(import.meta.url)), "../../tmp");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "memory-cost.json"), `${JSON.stringify(note, null, 2)}\n`);
});
