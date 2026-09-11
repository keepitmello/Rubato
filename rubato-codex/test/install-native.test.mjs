import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installPackage, uninstallPackage } from "../scripts/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const repoRoot = resolve(pluginRoot, "..");
const defaultCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexPath = process.env.RUBATO_CODEX_TEST_BINARY || defaultCodex;
const enabled = process.env.RUBATO_CODEX_NATIVE_E2E === "1";

function codexJson(codexHome, args) {
  const result = spawnSync(codexPath, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("native Codex installs, resolves, refreshes and uninstalls the cached plugin", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rubato-codex-native-test-"));
  const codexHome = join(root, "codex-home");
  const options = { pluginRoot, repoRoot, codexHome, codexPath };
  try {
    await access(codexPath);
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[features]\nmulti_agent_v2 = true\n');
    await installPackage(options);

    const installed = codexJson(codexHome, ["plugin", "list", "--json"]);
    const plugin = installed.installed.find((entry) => entry.pluginId === "rubato-codex@rubato");
    assert.equal(plugin.enabled, true);

    const mcp = codexJson(codexHome, ["mcp", "list", "--json"]);
    const taskforce = mcp.find((entry) => entry.name === "taskforce");
    assert.equal(taskforce.transport.command, "sh");
    assert.deepEqual(taskforce.transport.args, ["./scripts/taskforce-mcp.sh"]);
    const cacheRoot = resolve(taskforce.transport.cwd);
    assert.match(cacheRoot, /plugins\/cache\/rubato\/rubato-codex\/0\.1\.0$/);

    await access(join(cacheRoot, ".codex-plugin", "plugin.json"));
    await access(join(cacheRoot, "taskforce", "dist", "mcp-server.mjs"));
    await access(join(cacheRoot, "taskforce", "THIRD_PARTY_NOTICES.md"));
    await assert.rejects(access(join(cacheRoot, "node_modules")));

    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rubato-codex-native-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_create", arguments: {
        workspace: repoRoot,
        run_id: "native-installer-e2e",
        subject: "preserve this task through plugin refresh",
        description: "isolated native installer acceptance fixture",
      } } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const launched = spawnSync("sh", ["./scripts/taskforce-mcp.sh"], {
      cwd: cacheRoot,
      input,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin" },
    });
    assert.equal(launched.status, 0, launched.stderr);
    const responses = launched.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(responses.find((item) => item.id === 1).result.serverInfo.name, "taskforce");
    assert.deepEqual(
      responses.find((item) => item.id === 2).result.tools.map((tool) => tool.name),
      ["task_create", "task_list", "task_get", "task_update"],
    );
    assert.match(JSON.stringify(responses.find((item) => item.id === 3).result), /preserve this task through plugin refresh/);

    await writeFile(join(cacheRoot, "stale-sentinel"), "must disappear\n");
    await installPackage(options);
    await assert.rejects(access(join(cacheRoot, "stale-sentinel")));

    const refreshedPlugins = codexJson(codexHome, ["plugin", "list", "--json"]);
    const refreshedPlugin = refreshedPlugins.installed.find((entry) => entry.pluginId === "rubato-codex@rubato");
    assert.equal(refreshedPlugin.enabled, true);
    const refreshedMcp = codexJson(codexHome, ["mcp", "list", "--json"]);
    const refreshedTaskforce = refreshedMcp.find((entry) => entry.name === "taskforce");
    assert.equal(refreshedTaskforce.transport.cwd, taskforce.transport.cwd);

    const listInput = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rubato-codex-native-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "task_list", arguments: {
        workspace: repoRoot,
        run_id: "native-installer-e2e",
      } } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const listed = spawnSync("sh", ["./scripts/taskforce-mcp.sh"], {
      cwd: resolve(refreshedTaskforce.transport.cwd),
      input: listInput,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin" },
    });
    assert.equal(listed.status, 0, listed.stderr);
    const listResponses = listed.stdout.trim().split("\n").map(JSON.parse);
    assert.match(JSON.stringify(listResponses.find((item) => item.id === 4).result), /preserve this task through plugin refresh/);

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    assert.match(config, /rubato-codex managed bootstrap/);
    assert.ok(config.indexOf('sandbox_mode = "danger-full-access"') < config.indexOf("rubato-codex managed bootstrap"));
    assert.ok(config.indexOf("rubato-codex managed bootstrap") < config.indexOf("[features]"));

    const boardDir = join(codexHome, "taskforce");
    await mkdir(boardDir, { recursive: true });
    await writeFile(join(boardDir, "preserved-sentinel"), "board data\n");
    await uninstallPackage(options);
    const after = codexJson(codexHome, ["plugin", "list", "--json"]);
    assert.equal(after.installed.some((entry) => entry.pluginId === "rubato-codex@rubato"), false);
    assert.equal(await readFile(join(boardDir, "preserved-sentinel"), "utf8"), "board data\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
