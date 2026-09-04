import test from "node:test";
import assert from "node:assert/strict";
import { adapterPath, providerOverlayPath, buildSenpiArgs, leadOverlayPath, sameNodeBinary, senpiCliMainPath, senpiCliPath, senpiEntryPath, statuslinePath, readPinnedVersions } from "../../src/launch.mjs";
import { PIN } from "../../src/policy.mjs";

test("launcher pins exact engine plugin and senpi versions", () => {
  assert.deepEqual(readPinnedVersions(), { engine: PIN.engine, senpi: PIN.senpi });
});

test("senpi argv replaces the system prompt and lets profile settings choose the default model", () => {
  const args = buildSenpiArgs(["--mode", "rpc"], { env: {} });
  const promptAt = args.indexOf("--system-prompt");
  const statuslineAt = args.indexOf(statuslinePath());
  const leadAt = args.indexOf(leadOverlayPath());
  const providerAt = args.indexOf(providerOverlayPath());
  const adapterAt = args.indexOf(adapterPath());
  assert.ok(promptAt > 0);
  assert.match(args[promptAt + 1], /Working agreement/);
  assert.match(args[promptAt + 1], /`Agent` tool/);
  assert.match(args[promptAt + 1], /## Tool Guidelines/);
  assert.match(args[promptAt + 1], /one eval cell/);
  assert.doesNotMatch(args[promptAt + 1], /operating inside pi/);
  assert.doesNotMatch(args[promptAt + 1], /## Rails — fx/);
  assert.doesNotMatch(args[promptAt + 1], /Run `fx models`/);
  assert.doesNotMatch(args[promptAt + 1], /# Dispatching/);
  assert.doesNotMatch(args[promptAt + 1], /# Dispatched/);
  assert.doesNotMatch(args[promptAt + 1], /# Return/);
  assert.equal(args.includes("--model"), false);
  assert.ok(args.includes("-e"));
  assert.ok(statuslineAt > 0 && args[statuslineAt - 1] === "-e");
  assert.ok(leadAt > statuslineAt && args[leadAt - 1] === "-e");
  assert.ok(providerAt > leadAt && args[providerAt - 1] === "-e");
  assert.ok(adapterAt > providerAt && args[adapterAt - 1] === "-e");
});

test("member argv gets teammate prompt plus the same tool guidelines", () => {
  const args = buildSenpiArgs(["--mode", "rpc"], { env: { SENPI_TASK_MEMBER: "alpha" } });
  const prompt = args[args.indexOf("--system-prompt") + 1];
  assert.match(prompt, /# Workstream owner/);
  assert.match(prompt, /## Tool Guidelines/);
  assert.match(prompt, /one eval cell/);
  assert.doesNotMatch(prompt, /# Lead\n/);
  assert.doesNotMatch(prompt, /# Dispatching/);
  assert.doesNotMatch(prompt, /# Dispatched/);
  assert.doesNotMatch(prompt, /# Return/);
});

test("an explicit --model is not overwritten", () => {
  const args = buildSenpiArgs(["--model", "xai/grok-4.6"]);
  assert.equal(args.filter((token) => token === "--model").length, 1);
  assert.equal(args[args.indexOf("--model") + 1], "xai/grok-4.6");
});

test("resuming a session does not override its persisted model", () => {
  const args = buildSenpiArgs(["--session", "/tmp/session.jsonl"]);
  assert.equal(args.includes("--model"), false);
  assert.deepEqual(args.slice(-2), ["--session", "/tmp/session.jsonl"]);
});

test("an explicit model still overrides a resumed session", () => {
  const args = buildSenpiArgs(["--session", "/tmp/session.jsonl", "--model", "xai/grok-4.6"]);
  assert.equal(args.filter((token) => token === "--model").length, 1);
  assert.equal(args[args.indexOf("--model") + 1], "xai/grok-4.6");
});

test("interactive sessions default to fullscreen without overriding explicit modes", () => {
  const interactive = buildSenpiArgs([]);
  assert.equal(interactive[interactive.indexOf("--tui-mode") + 1], "fullscreen");

  const regular = buildSenpiArgs(["--tui-mode", "regular"]);
  assert.equal(regular.filter((token) => token === "--tui-mode").length, 1);
  assert.equal(regular[regular.indexOf("--tui-mode") + 1], "regular");

  assert.equal(buildSenpiArgs(["--mode", "rpc"]).includes("--tui-mode"), false);
  assert.equal(buildSenpiArgs(["--mode=print"]).includes("--tui-mode"), false);
});

test("launcher argv loads Rubato overlays rather than an rubato.js package entry", () => {
  const args = buildSenpiArgs(["--mode", "rpc"]);
  assert.ok(args.includes(statuslinePath()));
  assert.ok(args.includes(leadOverlayPath()));
  assert.ok(args.includes(adapterPath()));
  assert.equal(args.some((token) => token.endsWith("/rubato.js") || token.endsWith("\\rubato.js")), false);
});

test("print and json sessions inline the dispatched contract; interactive and rpc do not", () => {
  const promptOf = (userArgs) => {
    const args = buildSenpiArgs(userArgs, { env: {} });
    return args[args.indexOf("--system-prompt") + 1];
  };
  const printed = promptOf(["--print", "hello"]);
  assert.match(printed, /# Dispatched/);
  assert.match(printed, /Provisional:/);
  assert.match(printed, /# Return/);
  assert.match(printed, /Boss report only/);
  assert.match(printed, /This run's detail file:/);

  const json = promptOf(["--mode", "json"]);
  assert.match(json, /# Dispatched/);
  assert.match(json, /Provisional:/);
  assert.match(json, /# Return/);

  assert.doesNotMatch(promptOf([]), /# Dispatched/);
  assert.doesNotMatch(promptOf([]), /# Return/);
  assert.doesNotMatch(promptOf(["--mode", "rpc"]), /# Dispatched/);
  assert.doesNotMatch(promptOf(["--mode", "rpc"]), /# Return/);
});


test("interactive and help argv start at cli-main, version stays on the cheap cli.js path", () => {
  assert.equal(senpiEntryPath([]), senpiCliMainPath());
  assert.equal(senpiEntryPath(["--help"]), senpiCliMainPath());
  assert.equal(senpiEntryPath(["--version"]), senpiCliPath());
  assert.equal(senpiEntryPath(["-v"]), senpiCliPath());
  assert.equal(buildSenpiArgs([])[0], senpiCliMainPath());
  assert.equal(buildSenpiArgs(["--version"])[0], senpiCliPath());
});


test("the current process is treated as the same Node the launcher resolved", () => {
  assert.equal(sameNodeBinary(process.execPath), true);
  assert.equal(sameNodeBinary("/not/this/node"), false);
});
