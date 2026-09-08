import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyBundleDependencies, planBundleDependencies } from "../scripts/bundle-dependencies.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rubato-bundle-deps-"));
  const pluginRoot = join(root, "plugin");
  const source = join(pluginRoot, "skills/outpost/scripts/outpost");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "#!/usr/bin/env python3\n");
  return { root, pluginRoot, source, codexHome: join(root, "codex"), home: join(root, "home") };
}

test("dependency planning is read-only and reports feature readiness separately", async () => {
  const paths = await fixture();
  const plan = await planBundleDependencies({
    pluginRoot: paths.pluginRoot,
    codexHome: paths.codexHome,
    env: { HOME: paths.home, PATH: "" },
    platform: "linux",
  });
  plan.steps = [plan.steps.find((step) => step.id === "outpost-cli")];
  assert.equal(plan.steps[0].action, "link");
  assert.equal(plan.steps[0].target, join(paths.codexHome, "rubato-codex/bin/outpost"));
  await assert.rejects(lstat(paths.codexHome), /ENOENT/);
  assert.equal(plan.readiness.find((item) => item.id === "aside").status, "missing");
  assert.equal(plan.readiness.find((item) => item.id === "macos-computer-use").status, "unavailable");
  assert.deepEqual(plan.required.map((item) => item.id), ["public-browser-tools", "insane-search-python"]);
});

test("missing required npm and python prerequisites make setup incomplete with actionable reasons", async () => {
  const paths = await fixture();
  const plan = await planBundleDependencies({
    pluginRoot: paths.pluginRoot,
    codexHome: paths.codexHome,
    env: { HOME: paths.home, PATH: "" },
    platform: "linux",
  });
  assert.deepEqual(plan.required.map((item) => item.id), ["public-browser-tools", "insane-search-python"]);
  assert.match(plan.required[0].reason, /npm is required/);
  assert.match(plan.required[1].reason, /python3 is required/);
  const result = await applyBundleDependencies(plan, { dryRun: true });
  assert.equal(result.status, "attention");
  assert.deepEqual(result.items.filter((item) => item.status === "blocked").map((item) => item.id), ["public-browser-tools", "insane-search-python"]);
  assert.equal(result.items.find((item) => item.id === "aside-app").status, "deferred");
});

test("dry run returns recoverable ownership metadata without invoking the runner", async () => {
  const paths = await fixture();
  const plan = await planBundleDependencies({
    pluginRoot: paths.pluginRoot,
    codexHome: paths.codexHome,
    env: { HOME: paths.home, PATH: "" },
  });
  plan.steps = [plan.steps.find((step) => step.id === "outpost-cli")];
  let calls = 0;
  const result = await applyBundleDependencies(plan, { dryRun: true, runner: async () => { calls += 1; } });
  assert.equal(result.status, "planned");
  assert.equal(calls, 0);
  assert.deepEqual(result.cleanup, [{
    action: "unlink-if-target",
    target: join(paths.codexHome, "rubato-codex/bin/outpost"),
    expectedSource: await realpath(paths.source),
  }]);
});

test("apply exposes the bundled Outpost launcher and a second plan is idempotent", async () => {
  const paths = await fixture();
  const options = { pluginRoot: paths.pluginRoot, codexHome: paths.codexHome, env: { HOME: paths.home, PATH: "" } };
  const firstPlan = await planBundleDependencies(options);
  firstPlan.steps = [firstPlan.steps.find((step) => step.id === "outpost-cli")];
  const result = await applyBundleDependencies(firstPlan);
  assert.equal(result.status, "complete");
  const target = join(paths.codexHome, "rubato-codex/bin/outpost");
  assert.equal(await readlink(target), await realpath(paths.source));
  const repeated = await planBundleDependencies(options);
  repeated.steps = [repeated.steps.find((step) => step.id === "outpost-cli")];
  assert.equal(repeated.steps[0].action, "current");
  const repeatedResult = await applyBundleDependencies(repeated);
  assert.deepEqual(repeatedResult.cleanup, [{ action: "unlink-if-target", target, expectedSource: await realpath(paths.source) }]);
});

test("an unrelated executable is never overwritten", async () => {
  const paths = await fixture();
  const target = join(paths.codexHome, "rubato-codex/bin/outpost");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "user-owned\n");
  const plan = await planBundleDependencies({
    pluginRoot: paths.pluginRoot,
    codexHome: paths.codexHome,
    env: { HOME: paths.home, PATH: "" },
  });
  plan.steps = [plan.steps.find((step) => step.id === "outpost-cli")];
  assert.equal(plan.steps[0].action, "conflict");
  const result = await applyBundleDependencies(plan);
  assert.equal(result.status, "attention");
  assert.equal(await readFile(target, "utf8"), "user-owned\n");
});

test("install actions invoke the supplied runner and retain prefix cleanup ownership", async () => {
  const paths = await fixture();
  const plan = await planBundleDependencies({
    pluginRoot: paths.pluginRoot,
    codexHome: paths.codexHome,
    env: { HOME: paths.home, PATH: process.env.PATH },
    platform: "linux",
  });
  plan.steps = [plan.steps.find((step) => step.id === "public-browser-tools")];
  assert.equal(plan.steps[0].action, "install");
  assert.deepEqual(plan.steps[0].allowScripts, ["agent-browser@0.33.2"]);
  assert.ok(!plan.steps[0].argv.some((arg) => arg.startsWith("--allow-scripts")));
  const calls = [];
  const result = await applyBundleDependencies(plan, { runner: async (step) => calls.push(step.id) });
  assert.deepEqual(calls, ["public-browser-tools"]);
  assert.equal(result.items[0].status, "installed");
  assert.ok(result.cleanup.some((item) => item.action === "remove-tree-if-marker"));
});

test("the generated managed Python launcher executes the bundled engine as a module", async () => {
  const root = await mkdtemp(join(tmpdir(), "rubato-python-launcher-"));
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const plan = await planBundleDependencies({
    pluginRoot: packageRoot,
    codexHome: join(root, "codex"),
    env: { HOME: join(root, "home"), PATH: process.env.PATH },
    platform: "linux",
  });
  const python = plan.steps.find((step) => step.id === "insane-search-python");
  assert.equal(python.action, "install");
  python.packages = [];
  plan.steps = [python];
  const applied = await applyBundleDependencies(plan);
  assert.equal(applied.status, "complete");
  const smoke = spawnSync(python.launcher, ["--help"], { encoding: "utf8" });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.match(smoke.stdout, /Generic WAF-profile fetch chain/);
});

test("a bundled source symlink may not escape the package", async () => {
  const paths = await fixture();
  const outside = join(paths.root, "outside");
  await writeFile(outside, "#!/bin/sh\n");
  const source = join(paths.pluginRoot, "skills/outpost/scripts/outpost");
  await unlink(source);
  await symlink(outside, source);
  await assert.rejects(
    planBundleDependencies({ pluginRoot: paths.pluginRoot, codexHome: paths.codexHome, env: { HOME: paths.home, PATH: "" } }),
    /source symlink escapes plugin root/,
  );
});

test("dependency manifest accounts for every installed skill", async () => {
  const packageRoot = join(dirname(new URL(import.meta.url).pathname), "..");
  const bundle = JSON.parse(await readFile(join(packageRoot, "skill-bundle.json"), "utf8"));
  const dependencies = JSON.parse(await readFile(join(packageRoot, "bundle-dependencies.json"), "utf8"));
  const accounted = new Set([
    ...dependencies.managed.flatMap((item) => item.skills),
    ...dependencies.readiness.flatMap((item) => item.skills),
    ...dependencies.skillsWithoutExternalSetup,
  ]);
  const installed = [
    ...bundle.managed.map((name) => bundle.renames[name] || name),
    ...bundle.conditional,
    ...bundle.preserved,
    ...bundle.nativeOnly,
  ];
  assert.deepEqual(installed.filter((name) => !accounted.has(name)), []);
  assert.equal(new Set(installed).size, installed.length);
});
