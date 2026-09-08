import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyOpenCodexSetup, configureOpenCodexMultiAgent, configureOpenCodexRoster, OPENCODEX_VERSION, planOpenCodexSetup, registerOpenCodexProviders, removeManagedOpenCodex } from "../scripts/opencodex-setup.mjs";

test("native-only plan never installs OpenCodex", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-ocx-native-"));
  const plan = planOpenCodexSetup({ selectedProviders: [], codexHome: home, env: { PATH: "" } });
  assert.equal(plan.action, "skip");
  const result = await applyOpenCodexSetup(plan);
  assert.equal(result.status, "skipped");
});

test("private install dry run reports planned and performs no install", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-ocx-plan-"));
  const plan = planOpenCodexSetup({ selectedProviders: ["xai"], codexHome: home, env: { PATH: "" } });
  let called = false;
  const result = await applyOpenCodexSetup(plan, { dryRun: true, install: async () => { called = true; } });
  assert.equal(result.status, "planned");
  assert.equal(called, false);
});

test("matching OpenCodex is reused without touching the running service", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-ocx-existing-"));
  const ocx = join(home, "ocx");
  await writeFile(ocx, `#!/bin/sh\necho opencodex ${OPENCODEX_VERSION}\n`, { mode: 0o755 });
  const plan = planOpenCodexSetup({ selectedProviders: ["xai"], codexHome: home, opencodexPath: ocx, env: { PATH: "" } });
  assert.equal(plan.action, "use-existing");
  assert.equal(plan.version, OPENCODEX_VERSION);
  const result = await applyOpenCodexSetup(plan);
  assert.equal(result.managed, false);
  assert.equal(await readFile(ocx, "utf8"), `#!/bin/sh\necho opencodex ${OPENCODEX_VERSION}\n`);
});

test("private install is pinned, atomic, removable, and failure keeps the previous copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-ocx-private-"));
  const targetRoot = join(home, "rubato-codex", "dependencies", "opencodex");
  const plan = planOpenCodexSetup({ selectedProviders: ["cursor"], codexHome: home, targetRoot, env: { PATH: "" } });
  assert.equal(plan.action, "install-private");
  assert.match(plan.package, new RegExp(`@${OPENCODEX_VERSION.replaceAll(".", "\\.")}$`));
  const install = async (_plan, next) => {
    const packageDir = join(next, "node_modules", "@bitkyc08", "opencodex");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: OPENCODEX_VERSION }));
  };
  const installed = await applyOpenCodexSetup(plan, { install });
  assert.equal(installed.managed, true);
  assert.equal(JSON.parse(await readFile(join(targetRoot, "node_modules", "@bitkyc08", "opencodex", "package.json"))).version, OPENCODEX_VERSION);
  assert.equal(JSON.parse(await readFile(join(targetRoot, "rubato-opencodex.json"))).installedVersion, OPENCODEX_VERSION);
  await assert.rejects(applyOpenCodexSetup(plan, { install: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(JSON.parse(await readFile(join(targetRoot, "node_modules", "@bitkyc08", "opencodex", "package.json"))).version, OPENCODEX_VERSION);
  await removeManagedOpenCodex(installed);
  await assert.rejects(readFile(join(targetRoot, "node_modules", "@bitkyc08", "opencodex", "package.json")), { code: "ENOENT" });
});

test("an older installer-owned private version upgrades while an unowned prefix is refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-ocx-upgrade-"));
  const targetRoot = join(home, "rubato-codex", "dependencies", "opencodex");
  const packageDir = join(targetRoot, "node_modules", "@bitkyc08", "opencodex");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "2.42.0" }));
  await writeFile(join(targetRoot, "rubato-opencodex.json"), JSON.stringify({ version: 1, packageName: "@bitkyc08/opencodex", installedVersion: "2.42.0" }));
  const plan = planOpenCodexSetup({ selectedProviders: ["xai"], codexHome: home, env: { PATH: "" } });
  const install = async (_plan, next) => {
    const nextPackage = join(next, "node_modules", "@bitkyc08", "opencodex");
    await mkdir(nextPackage, { recursive: true });
    await writeFile(join(nextPackage, "package.json"), JSON.stringify({ version: OPENCODEX_VERSION }));
  };
  await applyOpenCodexSetup(plan, { install });
  assert.equal(JSON.parse(await readFile(join(packageDir, "package.json"))).version, OPENCODEX_VERSION);
  await writeFile(join(targetRoot, "rubato-opencodex.json"), "{}");
  await assert.rejects(applyOpenCodexSetup(plan, { install }), /unowned OpenCodex target/);
});

test("provider registration and fresh exact-model roster are noninteractive and explicit", async () => {
  const setup = { command: "/managed/ocx", selectedProviders: ["cursor", "xai"] };
  const calls = [];
  const registration = await registerOpenCodexProviders(setup, {
    providers: [{ id: "cursor", configured: true }, { id: "xai", configured: false }],
  }, { runner: async (command, provider) => calls.push([command, provider]) });
  assert.deepEqual(calls, [["/managed/ocx", "xai"]]);
  assert.equal(registration.status, "authentication-pending");
  const roster = await configureOpenCodexRoster(setup, {
    providers: [
      { id: "cursor", models: ["cursor/claude-fable-5-1", "cursor/claude-opus-5", "cursor/gemini-3.8-flash"] },
      { id: "xai", models: ["xai/grok-4.6"] },
    ],
  }, { runner: async (command, models) => calls.push([command, ...models]) });
  // Every slot is routed: native gpt rows are spawn candidates without the roster, so spending a
  // slot on one wastes it. xai outranks cursor, and roles keep their order inside a provider.
  assert.deepEqual(roster.models, ["xai/grok-4.6", "cursor/claude-opus-5", "cursor/claude-fable-5-1", "cursor/gemini-3.8-flash"]);
  assert.deepEqual(calls[1], ["/managed/ocx", ...roster.models]);
});

test("roster prefers direct providers and never spends a slot twice", async () => {
  const setup = { command: "/managed/ocx", selectedProviders: ["anthropic", "cursor", "xai"] };
  const roster = await configureOpenCodexRoster(setup, {
    providers: [
      { id: "cursor", models: ["cursor/claude-opus-5", "cursor/grok-4.6", "cursor/gemini-3.7-flash"] },
      { id: "anthropic", models: ["anthropic/claude-opus-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5"] },
      { id: "xai", models: ["xai/grok-4.6"] },
    ],
  }, { runner: async () => {} });
  assert.deepEqual(roster.models, [
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-sonnet-5",
    "xai/grok-4.6",
    "cursor/gemini-3.7-flash",
  ]);
  assert.equal(new Set(roster.models).size, roster.models.length);
  assert.ok(roster.models.every((model) => model.includes("/")), "native models waste a roster slot");
});

test("multi-agent setup turns on keep-native-v1 so routed spawns can run", async () => {
  const calls = [];
  const setup = { command: "/managed/ocx", selectedProviders: ["anthropic"] };
  const configured = await configureOpenCodexMultiAgent(setup, { runner: async (command) => calls.push(command) });
  assert.deepEqual(calls, ["/managed/ocx"]);
  assert.equal(configured.keepNativeChatGptOnV1, true);
  assert.equal(configured.status, "configured");

  const planned = await configureOpenCodexMultiAgent(setup, { dryRun: true, runner: async () => assert.fail("dry run must not run the CLI") });
  assert.equal(planned.status, "planned");

  const native = await configureOpenCodexMultiAgent({ command: "/managed/ocx", selectedProviders: [] }, { runner: async () => assert.fail("native-only install must not touch multi-agent config") });
  assert.equal(native.status, "native-codex-only");
});
