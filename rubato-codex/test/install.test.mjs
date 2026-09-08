import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { installPackage, uninstallPackage } from "../scripts/install.mjs";

const roles = ["taskforce_owner", "taskforce_verifier", "taskforce_helper"];
const skills = ["agent-taskforce", "dispatching", "dispatched", "codex-discusser", "codex-reviewer", "keep-simple"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rubato-codex-install-"));
  const repoRoot = join(root, "repo");
  const pluginRoot = join(repoRoot, "rubato-codex");
  const codexHome = join(root, "codex-home");
  const fakeCodex = join(root, "codex");
  const fakeState = join(root, "fake-codex-state.json");
  const fakeLog = join(root, "fake-codex.log");
  await mkdir(join(repoRoot, ".agents", "plugins"), { recursive: true });
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "agents"), { recursive: true });
  await mkdir(join(pluginRoot, "instructions"), { recursive: true });
  await mkdir(join(pluginRoot, "taskforce", "dist"), { recursive: true });
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await writeFile(join(repoRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "rubato",
    plugins: [{ name: "rubato-codex", source: { source: "local", path: "./rubato-codex" } }],
  }));
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "rubato-codex",
    version: "0.1.0",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  }));
  await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({
    mcpServers: { taskforce: { command: "sh", args: ["./scripts/taskforce-mcp.sh"], cwd: "." } },
  }));
  await writeFile(join(pluginRoot, "bundle-dependencies.json"), "{}\n");
  for (const role of roles) {
    await writeFile(join(pluginRoot, "agents", `${role}.toml`), `name = "${role}"\ndescription = "${role} description"\ndeveloper_instructions = "role contract"\n`);
  }
  for (const skill of skills) {
    await mkdir(join(pluginRoot, "skills", skill), { recursive: true });
    await writeFile(join(pluginRoot, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fixture\n---\n`);
  }
  await mkdir(join(pluginRoot, "skills", "outpost", "scripts"), { recursive: true });
  await writeFile(join(pluginRoot, "skills", "outpost", "SKILL.md"), "---\nname: outpost\ndescription: fixture\n---\n");
  await writeFile(join(pluginRoot, "skills", "outpost", "scripts", "outpost"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(pluginRoot, "instructions", "AGENTS.md"), "Use native Rubato taskforce roles.\n");
  await writeFile(join(pluginRoot, "instructions", "base.md"), "Rubato Codex base prompt.\n");
  await writeFile(join(pluginRoot, "taskforce", "dist", "mcp-server.mjs"), "// fixture bundle\n");
  await writeFile(join(pluginRoot, "scripts", "taskforce-mcp.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { marketplaces: [], installed: [] };
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("codex-cli 0.153.4"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "--help") { console.log("Manage Codex plugins"); process.exit(0); }
if (args[1] === "marketplace" && args[2] === "list") { console.log(JSON.stringify({marketplaces: state.marketplaces})); process.exit(0); }
if (args[1] === "marketplace" && args[2] === "add") {
  state.marketplaces.push({name:"rubato",root:args[3],marketplaceSource:{sourceType:"local",source:args[3]}});
  fs.writeFileSync(statePath, JSON.stringify(state)); console.log("{}"); process.exit(0);
}
if (args[1] === "list") { console.log(JSON.stringify({installed: state.installed, available: []})); process.exit(0); }
if (args[1] === "add") {
  state.installed.push({pluginId:args[2],name:"rubato-codex",marketplaceName:"rubato"});
  fs.writeFileSync(statePath, JSON.stringify(state));
  const configPath = process.env.CODEX_HOME + "/config.toml";
  fs.mkdirSync(process.env.CODEX_HOME, {recursive:true});
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  if (!config.includes('[plugins."rubato-codex@rubato"]')) {
    fs.writeFileSync(configPath, config + '\\n[plugins."rubato-codex@rubato"]\\nenabled = true\\n');
  }
  console.log("{}"); process.exit(0);
}
if (args[1] === "remove") { state.installed = state.installed.filter((item) => item.pluginId !== args[2]); fs.writeFileSync(statePath, JSON.stringify(state)); console.log("{}"); process.exit(0); }
console.error("unexpected", args); process.exit(2);
`);
  await chmod(fakeCodex, 0o755);
  process.env.FAKE_CODEX_STATE = fakeState;
  process.env.FAKE_CODEX_LOG = fakeLog;
  return { root, repoRoot, pluginRoot, codexHome, fakeCodex, fakeLog };
}

function options(f) {
  return {
    pluginRoot: f.pluginRoot,
    repoRoot: f.repoRoot,
    codexHome: f.codexHome,
    codexPath: f.fakeCodex,
    env: { ...process.env, HOME: join(f.root, "home") },
    bundleDependencyRunner: async () => {},
    openCodexProviderRunner: async () => {},
    openCodexRosterRunner: async () => {},
  };
}

test("install is idempotent and uninstall removes only managed content", async () => {
  const f = await fixture();
  await mkdir(f.codexHome, { recursive: true });
  await writeFile(join(f.codexHome, "config.toml"), "model = \"user-model\"\n\n[tui]\nstatus_line = [\"model\"]\n");
  await writeFile(join(f.codexHome, "AGENTS.md"), "User instructions stay.\n");

  await installPackage(options(f));
  await installPackage(options(f));
  const config = await readFile(join(f.codexHome, "config.toml"), "utf8");
  const agents = await readFile(join(f.codexHome, "AGENTS.md"), "utf8");
  assert.equal((config.match(/rubato-codex managed bootstrap >>>/g) || []).length, 1);
  assert.equal((agents.match(/rubato-codex managed instructions >>>/g) || []).length, 1);
  assert.match(config, /model = "user-model"/);
  assert.match(config, /model_instructions_file = .*rubato-codex.*model-instructions\.md/);
  assert.match(config, /\[plugins\."rubato-codex@rubato"\]/);
  assert.doesNotMatch(config, /model_reasoning_effort/);
  assert.ok(config.indexOf('model = "user-model"') < config.indexOf("rubato-codex managed bootstrap"));
  assert.ok(config.indexOf("rubato-codex managed bootstrap") < config.indexOf("[tui]"));
  for (const role of roles) assert.match(config, new RegExp(`\\[agents\\.${role}\\]`));

  const calls = (await readFile(f.fakeLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call[1] === "marketplace" && call[2] === "add").length, 1);
  assert.equal(calls.filter((call) => call[1] === "add").length, 2);
  assert.equal(calls.filter((call) => call[1] === "remove").length, 1);

  await writeFile(join(f.codexHome, "config.toml"), `${config}\n[notice]\nvalue = \"later\"\n`);
  await writeFile(join(f.codexHome, "AGENTS.md"), `${agents}\nLater user instruction.\n`);
  await uninstallPackage(options(f));
  const configAfter = await readFile(join(f.codexHome, "config.toml"), "utf8");
  const agentsAfter = await readFile(join(f.codexHome, "AGENTS.md"), "utf8");
  assert.match(configAfter, /model = "user-model"/);
  assert.match(configAfter, /\[notice\]/);
  assert.doesNotMatch(configAfter, /rubato-codex managed/);
  await assert.rejects(readFile(join(f.codexHome, "rubato-codex", "model-instructions.md"), "utf8"), { code: "ENOENT" });
  assert.match(agentsAfter, /User instructions stay/);
  assert.match(agentsAfter, /Later user instruction/);
  assert.doesNotMatch(agentsAfter, /rubato-codex managed/);
  await assert.rejects(lstat(join(f.root, "home", ".local", "bin", "outpost")), { code: "ENOENT" });
  for (const role of roles) {
    await assert.rejects(readFile(join(f.codexHome, "agents", `${role}.toml`), "utf8"), { code: "ENOENT" });
  }
});

test("installer replaces and later restores the exact root model instructions scalar and target", async () => {
  const f = await fixture();
  const target = join(f.codexHome, "rubato-codex", "model-instructions.md");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "user prompt source\n");
  await writeFile(join(f.codexHome, "config.toml"), `model_instructions_file = ${JSON.stringify(target)} # keep exact\n\n[features]\nmulti_agent_v2 = true\n`);
  await installPackage(options(f));
  assert.equal(await readFile(target, "utf8"), "Rubato Codex base prompt.\n");
  const installed = await readFile(join(f.codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(installed, /# keep exact/);
  await uninstallPackage(options(f));
  assert.equal(await readFile(target, "utf8"), "user prompt source\n");
  const restored = await readFile(join(f.codexHome, "config.toml"), "utf8");
  assert.match(restored, new RegExp(`model_instructions_file = ${JSON.stringify(target).replaceAll("\\", "\\\\")} # keep exact`));
});

test("update and uninstall refuse model instruction pointer or empty-file drift", async () => {
  const f = await fixture();
  await installPackage(options(f));
  const configPath = join(f.codexHome, "config.toml");
  const installedConfig = await readFile(configPath, "utf8");
  await writeFile(configPath, installedConfig.replace(/model_instructions_file = .*$/m, 'model_instructions_file = "/user/changed.md"'));
  await assert.rejects(installPackage(options(f)), /changed model_instructions_file/);
  await assert.rejects(uninstallPackage(options(f)), /changed model_instructions_file/);
  await writeFile(configPath, installedConfig);
  await writeFile(join(f.codexHome, "rubato-codex", "model-instructions.md"), "");
  await assert.rejects(installPackage(options(f)), /modified model instructions/);
  await assert.rejects(uninstallPackage(options(f)), /modified model instructions/);
});

test("update refuses unmanaged taskforce tables without changing their bytes", async () => {
  const f = await fixture();
  await installPackage(options(f));
  const configPath = join(f.codexHome, "config.toml");
  const drifted = `${await readFile(configPath, "utf8")}\n[agents.taskforce_custom]\ndescription = "user owned"\nconfig_file = "/tmp/user.toml"\n`;
  await writeFile(configPath, drifted);
  await assert.rejects(installPackage(options(f)), /unmanaged taskforce config appeared/);
  assert.equal(await readFile(configPath, "utf8"), drifted);
});

test("dry-run plans but does not write", async () => {
  const f = await fixture();
  const plan = await installPackage({ ...options(f), dryRun: true });
  assert.equal(plan.action, "install");
  assert.equal(plan.dryRun, true);
  await assert.rejects(readFile(join(f.codexHome, "config.toml"), "utf8"), { code: "ENOENT" });
});

test("installer records provider subset and preserves it on an update without --providers", async () => {
  const f = await fixture();
  const opencodexHome = join(f.root, "opencodex-home");
  await mkdir(opencodexHome, { recursive: true });
  await writeFile(join(opencodexHome, "config.json"), JSON.stringify({
    port: 10100,
    providers: {
      openai: {},
      cursor: { models: ["gpt-5.6-sol"], selectedModels: ["gpt-5.6-sol"] },
      xai: { models: ["grok-4.6"] },
      anthropic: { models: ["claude-opus-5"] },
    },
  }));

  const ocxEnvs = [];
  const first = await installPackage({
    ...options(f),
    opencodexHome,
    providers: "xai,cursor",
    openCodexProviderRunner: async (_command, _provider, env) => ocxEnvs.push(env),
    openCodexRosterRunner: async (_command, _models, env) => ocxEnvs.push(env),
  });
  assert.deepEqual(first.providers, ["cursor", "xai"]);
  assert.equal(first.providerSelection, "explicit");
  let policy = JSON.parse(await readFile(join(f.codexHome, "rubato-codex", "providers.json"), "utf8"));
  assert.deepEqual(policy.selectedProviders, ["cursor", "xai"]);
  assert.deepEqual(policy.availableProviders.map((provider) => provider.id), ["anthropic", "cursor", "kiro", "xai"]);
  assert.deepEqual(policy.availableProviders.find((provider) => provider.id === "cursor").models, ["cursor/gpt-5.6-sol"]);
  assert.ok(ocxEnvs.length > 0);
  assert.ok(ocxEnvs.every((env) => env.CODEX_HOME === f.codexHome && env.OPENCODEX_HOME === opencodexHome));

  await writeFile(join(opencodexHome, "config.json"), JSON.stringify({ providers: { openai: {} } }));
  const update = await installPackage({ ...options(f), opencodexHome });
  assert.deepEqual(update.providers, ["cursor", "xai"]);
  assert.equal(update.providerSelection, "preserved");
  policy = JSON.parse(await readFile(join(f.codexHome, "rubato-codex", "providers.json"), "utf8"));
  assert.deepEqual(policy.selectedProviders, ["cursor", "xai"]);
  assert.deepEqual(policy.availableProviders.map((provider) => provider.id), ["anthropic", "cursor", "kiro", "xai"]);

  const nativeOnly = await installPackage({ ...options(f), opencodexHome, providers: "none" });
  assert.deepEqual(nativeOnly.providers, ["native-codex-only"]);
  policy = JSON.parse(await readFile(join(f.codexHome, "rubato-codex", "providers.json"), "utf8"));
  assert.deepEqual(policy.selectedProviders, []);
});

test("fresh provider plan bootstraps OpenCodex without writing or running setup", async () => {
  const f = await fixture();
  const plan = await installPackage({ ...options(f), dryRun: true, opencodexHome: join(f.root, "missing-opencodex"), providers: "xai", env: { PATH: "", HOME: join(f.root, "home") } });
  assert.equal(plan.openCodex.action, "install-private");
  assert.deepEqual(plan.openCodex.providerSetup.register, ["xai"]);
  assert.equal(plan.openCodex.providerSetup.status, "authentication-pending");
  await assert.rejects(readFile(join(f.codexHome, "config.toml"), "utf8"), { code: "ENOENT" });
});

test("unrelated role collision is refused", async () => {
  const f = await fixture();
  await mkdir(join(f.codexHome, "agents"), { recursive: true });
  await writeFile(join(f.codexHome, "agents", "taskforce_owner.toml"), "name = \"someone_else\"\n");
  await assert.rejects(installPackage(options(f)), /role collision/);
  await assert.rejects(installPackage({ ...options(f), legacyMigration: true }), /role collision/);
});

test("explicit legacy migration backs up and uninstall restores generated roles and config", async () => {
  const f = await fixture();
  await mkdir(join(f.codexHome, "agents"), { recursive: true });
  const legacyFiles = new Map();
  for (const role of roles) {
    const content = `# Generated by agent-taskforce/scripts/sync-codex-roles.mjs. Edit canonical sources.\nname = "${role}"\nmodel = "legacy"\n`;
    legacyFiles.set(role, content);
    await writeFile(join(f.codexHome, "agents", `${role}.toml`), content);
  }
  const legacyConfig = `approval_policy = "never"\n\n${roles.map((role) => `[agents.${role}]\nconfig_file = "/legacy/${role}.toml"\n`).join("\n")}[tui]\nstatus_line = ["model"]\n`;
  const legacyMcp = `[mcp_servers.taskforce]\ncommand = "node"\nargs = ["/legacy/taskforce/src/mcp-server.js"]\n\n[mcp_servers.taskforce.env]\nTASKFORCE_STATE_DIR = ${JSON.stringify(join(f.codexHome, "taskforce"))}\n`;
  const unrelatedArray = `[[skills.config]]\npath = "/unrelated/SKILL.md"\nenabled = true\n`;
  await writeFile(join(f.codexHome, "config.toml"), `${legacyConfig}\n${legacyMcp}\n${unrelatedArray}`);
  for (const skill of skills) {
    const source = join(f.pluginRoot, "skills", skill, "SKILL.md");
    await mkdir(join(f.codexHome, "skills", skill), { recursive: true });
    await writeFile(join(f.codexHome, "skills", skill, "SKILL.md"), await readFile(source, "utf8"));
  }

  await assert.rejects(installPackage(options(f)), /role collision/);
  await installPackage({ ...options(f), legacyMigration: true });
  const state = JSON.parse(await readFile(join(f.codexHome, "rubato-codex", "install-state.json"), "utf8"));
  assert.equal(state.legacyConfigSections.length, 3);
  assert.equal(state.legacyMcpSections.length, 2);
  assert.equal(state.disabledSkillPaths.length, 6);
  for (const role of roles) assert.ok(state.roles[role].previousBackup);

  await uninstallPackage(options(f));
  const restoredConfig = await readFile(join(f.codexHome, "config.toml"), "utf8");
  assert.match(restoredConfig, /approval_policy = "never"/);
  assert.match(restoredConfig, /\[tui\]/);
  assert.match(restoredConfig, /\[mcp_servers\.taskforce\]/);
  assert.match(restoredConfig, /\[\[skills\.config\]\]/);
  assert.match(restoredConfig, /\/unrelated\/SKILL\.md/);
  for (const role of roles) {
    assert.match(restoredConfig, new RegExp(`\\[agents\\.${role}\\]`));
    assert.equal(await readFile(join(f.codexHome, "agents", `${role}.toml`), "utf8"), legacyFiles.get(role));
  }
});

test("package roles may not pin model selection", async () => {
  const f = await fixture();
  await writeFile(join(f.pluginRoot, "agents", "taskforce_owner.toml"), "name = \"taskforce_owner\"\ndescription = \"owner\"\nmodel = \"gpt-5.6-sol\"\n");
  await assert.rejects(installPackage({ ...options(f), dryRun: true }), /pins a model/);
});

test("legacy MCP custom board directory is refused instead of silently switching state", async () => {
  const f = await fixture();
  await mkdir(join(f.codexHome, "agents"), { recursive: true });
  for (const role of roles) {
    await writeFile(join(f.codexHome, "agents", `${role}.toml`), `# Generated by agent-taskforce/scripts/sync-codex-roles.mjs.\nname = "${role}"\n`);
  }
  await writeFile(join(f.codexHome, "config.toml"), `[mcp_servers.taskforce]\ncommand = "node"\nargs = ["/legacy/taskforce/src/mcp-server.js"]\n\n[mcp_servers.taskforce.env]\nTASKFORCE_STATE_DIR = '/custom/board' # preserve me\n`);
  await assert.rejects(
    installPackage({ ...options(f), legacyMigration: true, dryRun: true }),
    /custom TASKFORCE_STATE_DIR/,
  );
});

test("explicit migration recognizes shared .agents skill symlinks without moving them", async () => {
  const f = await fixture();
  const shared = join(f.root, ".agents", "skills", "agent-taskforce");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "SKILL.md"), "shared canonical skill\n");
  await mkdir(join(f.codexHome, "skills"), { recursive: true });
  await symlink(shared, join(f.codexHome, "skills", "agent-taskforce"));
  const plan = await installPackage({ ...options(f), legacyMigration: true, dryRun: true });
  assert.deepEqual(plan.disabledLegacySkills, [join(f.codexHome, "skills", "agent-taskforce", "SKILL.md")]);
  assert.equal((await lstat(join(f.codexHome, "skills", "agent-taskforce"))).isSymbolicLink(), true);
});

test("update preserves prior disabled skills and checks newly bundled skill collisions", async () => {
  const f = await fixture();
  await installPackage(options(f));

  const originalShared = join(f.root, ".agents", "skills", "agent-taskforce");
  await mkdir(originalShared, { recursive: true });
  await writeFile(join(originalShared, "SKILL.md"), await readFile(join(f.pluginRoot, "skills", "agent-taskforce", "SKILL.md"), "utf8"));
  await mkdir(join(f.codexHome, "skills"), { recursive: true });
  await symlink(originalShared, join(f.codexHome, "skills", "agent-taskforce"));
  const installedStatePath = join(f.codexHome, "rubato-codex", "install-state.json");
  const installedState = JSON.parse(await readFile(installedStatePath, "utf8"));
  installedState.disabledSkillPaths = [join(f.codexHome, "skills", "agent-taskforce", "SKILL.md")];
  await writeFile(installedStatePath, `${JSON.stringify(installedState, null, 2)}\n`);

  const added = "new-portable-skill";
  const addedSource = join(f.pluginRoot, "skills", added);
  const addedShared = join(f.root, ".agents", "skills", added);
  await mkdir(addedSource, { recursive: true });
  await mkdir(addedShared, { recursive: true });
  await writeFile(join(addedSource, "SKILL.md"), `---\nname: ${added}\ndescription: fixture\n---\n`);
  await writeFile(join(addedShared, "SKILL.md"), "shared source may be adapted by the bundle\n");
  await symlink(addedShared, join(f.codexHome, "skills", added));

  await installPackage(options(f));
  const updatedState = JSON.parse(await readFile(installedStatePath, "utf8"));
  assert.deepEqual(updatedState.disabledSkillPaths, [
    join(f.codexHome, "skills", "agent-taskforce", "SKILL.md"),
    join(f.codexHome, "skills", added, "SKILL.md"),
  ]);
});

test("update refuses an unrecognized collision from a newly bundled skill", async () => {
  const f = await fixture();
  await installPackage(options(f));
  const added = "new-portable-skill";
  await mkdir(join(f.pluginRoot, "skills", added), { recursive: true });
  await writeFile(join(f.pluginRoot, "skills", added, "SKILL.md"), `---\nname: ${added}\ndescription: fixture\n---\n`);
  await mkdir(join(f.codexHome, "skills", added), { recursive: true });
  await writeFile(join(f.codexHome, "skills", added, "SKILL.md"), "user-owned different skill\n");
  await assert.rejects(installPackage(options(f)), /refusing to disable unrecognized skill collision/);
});

test("explicit duplicate skill path is disabled without modifying its source", async () => {
  const f = await fixture();
  const sharedSkill = join(f.root, ".agents", "skills", "keep-simple", "SKILL.md");
  await mkdir(join(f.root, ".agents", "skills", "keep-simple"), { recursive: true });
  await writeFile(sharedSkill, "user source remains untouched\n");
  await installPackage({ ...options(f), disableSkillPaths: [sharedSkill] });
  const config = await readFile(join(f.codexHome, "config.toml"), "utf8");
  assert.ok(config.includes(`path = ${JSON.stringify(sharedSkill)}`));
  assert.equal(await readFile(sharedSkill, "utf8"), "user source remains untouched\n");
  await uninstallPackage(options(f));
  assert.equal(await readFile(sharedSkill, "utf8"), "user source remains untouched\n");
});

test("explicit path authorizes its matching auto collision before conservative rejection", async () => {
  const f = await fixture();
  const collision = join(f.codexHome, "skills", "keep-simple", "SKILL.md");
  await mkdir(dirname(collision), { recursive: true });
  await writeFile(collision, "user source remains untouched\n");
  await installPackage({ ...options(f), disableSkillPaths: [collision] });
  const state = JSON.parse(await readFile(join(f.codexHome, "rubato-codex", "install-state.json"), "utf8"));
  assert.deepEqual(state.disabledSkillPaths, [collision]);
  assert.equal(await readFile(collision, "utf8"), "user source remains untouched\n");
});

test("case-only manifest rename recognizes a shared .agents skill symlink", async () => {
  const f = await fixture();
  const bundled = join(f.pluginRoot, "skills", "metaframe");
  const shared = join(f.root, ".agents", "skills", "metaFrame");
  await mkdir(bundled, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(bundled, "SKILL.md"), "adapted bundled content\n");
  await writeFile(join(shared, "SKILL.md"), "original shared content\n");
  await mkdir(join(f.codexHome, "skills"), { recursive: true });
  await symlink(shared, join(f.codexHome, "skills", "metaframe"));
  const plan = await installPackage({ ...options(f), legacyMigration: true, dryRun: true });
  assert.deepEqual(plan.disabledLegacySkills, [join(f.codexHome, "skills", "metaframe", "SKILL.md")]);
});

test("conservative config editor refuses TOML multiline strings", async () => {
  const f = await fixture();
  await mkdir(f.codexHome, { recursive: true });
  await writeFile(join(f.codexHome, "config.toml"), 'custom = """\n[agents.not_a_real_section]\n"""\n');
  await assert.rejects(installPackage({ ...options(f), dryRun: true }), /TOML multiline strings/);
});
