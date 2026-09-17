import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs, sameNodeBinary } from "../../src/launch.mjs";
import { TOOL_GUIDELINES } from "../../src/system-prompt.mjs";

test("pi argv replaces the system prompt and lets profile settings choose the default model", () => {
  const args = buildPiArgs(["--mode", "rpc"], { env: {} });
  const promptAt = args.indexOf("--system-prompt");
  assert.ok(promptAt >= 0);
  assert.match(args[promptAt + 1], /Working agreement/);
  // 785f6a3f9 이후 리드 프롬프트는 `Agent` 를 "rail" 로 부른다. 문구가 아니라
  // 생성물이 통째로 argv 에 실렸는지를 본다.
  assert.match(args[promptAt + 1], /`Agent` is the rail for a result you take back/);
  assert.match(args[promptAt + 1], /## Tool Guidelines/);
  assert.ok(args[promptAt + 1].includes(TOOL_GUIDELINES));
  assert.doesNotMatch(args[promptAt + 1], /operating inside pi/);
  assert.doesNotMatch(args[promptAt + 1], /## Rails — fx/);
  assert.doesNotMatch(args[promptAt + 1], /Run `fx models`/);
  assert.doesNotMatch(args[promptAt + 1], /# Dispatching/);
  assert.doesNotMatch(args[promptAt + 1], /# Dispatched/);
  assert.doesNotMatch(args[promptAt + 1], /# Return/);
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("-e"), false);
});

test("member argv gets teammate prompt plus the same tool guidelines", () => {
  const args = buildPiArgs(["--mode", "rpc"], { env: { SENPI_TASK_MEMBER: "alpha" } });
  const prompt = args[args.indexOf("--system-prompt") + 1];
  assert.match(prompt, /# Workstream owner/);
  assert.match(prompt, /## Tool Guidelines/);
  assert.ok(prompt.includes(TOOL_GUIDELINES));
  assert.doesNotMatch(prompt, /# Lead\n/);
  assert.doesNotMatch(prompt, /# Dispatching/);
  assert.doesNotMatch(prompt, /# Dispatched/);
  assert.doesNotMatch(prompt, /# Return/);
});

test("an explicit --model is not overwritten", () => {
  const args = buildPiArgs(["--model", "xai/grok-4.6"]);
  assert.equal(args.filter((token) => token === "--model").length, 1);
  assert.equal(args[args.indexOf("--model") + 1], "xai/grok-4.6");
});

test("resuming a session does not override its persisted model", () => {
  const args = buildPiArgs(["--session", "/tmp/session.jsonl"]);
  assert.equal(args.includes("--model"), false);
  assert.deepEqual(args.slice(-2), ["--session", "/tmp/session.jsonl"]);
});

test("an explicit model still overrides a resumed session", () => {
  const args = buildPiArgs(["--session", "/tmp/session.jsonl", "--model", "xai/grok-4.6"]);
  assert.equal(args.filter((token) => token === "--model").length, 1);
  assert.equal(args[args.indexOf("--model") + 1], "xai/grok-4.6");
});

test("interactive sessions default to fullscreen without overriding explicit modes", () => {
  const interactive = buildPiArgs([]);
  assert.equal(interactive[interactive.indexOf("--tui-mode") + 1], "fullscreen");

  const regular = buildPiArgs(["--tui-mode", "regular"]);
  assert.equal(regular.filter((token) => token === "--tui-mode").length, 1);
  assert.equal(regular[regular.indexOf("--tui-mode") + 1], "regular");

  assert.equal(buildPiArgs(["--mode", "rpc"]).includes("--tui-mode"), false);
  assert.equal(buildPiArgs(["--mode=print"]).includes("--tui-mode"), false);
});

test("print and json sessions inline the dispatched contract; interactive and rpc do not", () => {
  const promptOf = (userArgs) => {
    const args = buildPiArgs(userArgs, { env: {} });
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

test("the current process is treated as the same Node the launcher resolved", () => {
  assert.equal(sameNodeBinary(process.execPath), true);
  assert.equal(sameNodeBinary("/not/this/node"), false);
});
