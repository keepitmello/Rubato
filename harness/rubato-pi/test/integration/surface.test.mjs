import test from "node:test";
import assert from "node:assert/strict";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { probeRpc } from "../helpers/rpc-surface.mjs";

const MEMORY = ["memory", "dream", "palace"];
const TASK = ["tasks", "task-kill"];

test("lead overlay plus adapter keeps task and memory without inactive skill bundles", { timeout: 60_000 }, async () => {
  const surface = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
  });
  for (const name of [...MEMORY, ...TASK]) {
    assert.ok(surface.extensionCommands.includes(name), `missing ${name}`);
  }
  assert.equal(
    surface.skills.some((name) => name.includes("ultrawork") || name.includes("visual-qa")),
    false,
  );
  assert.ok(surface.mcpServers.includes("_ast_grep"));
  assert.ok(surface.extensions.some((e) => e.path.endsWith("lead-overlay.mjs")));
  assert.ok(surface.extensions.some((e) => e.path.endsWith("adapter.mjs")));
  assert.equal(surface.extensionCommands.includes("login"), false);
  assert.equal(surface.extensionCommands.includes("approve-spawn"), false);
});

test("a team member process gets task tools back for nested helpers", { timeout: 60_000 }, async () => {
  const surface = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
    env: { SENPI_TASK_MEMBER: "probe-member" },
  });
  for (const name of TASK) {
    assert.ok(surface.extensionCommands.includes(name), `member missing ${name}`);
  }
});

test("adapter alone is the DAG profile: no task engine, memory stays", { timeout: 60_000 }, async () => {
  const surface = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", adapterPath()],
  });
  for (const name of TASK) {
    assert.equal(surface.extensionCommands.includes(name), false, `${name} should be off for DAG`);
  }
  for (const name of MEMORY) {
    assert.ok(surface.extensionCommands.includes(name), `missing ${name}`);
  }
  assert.ok(surface.mcpServers.includes("_ast_grep"));
});
