import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  dispatchInternalAction,
  registerInternalAction,
} from "../../src/transforms/internal-actions.mjs";
import {
  isGitWork,
  isSkillRead,
  ToolGroupComponent,
  UNGROUPED_TOOLS,
} from "../../src/transforms/tool-group-component.mjs";
import { TurnWorkSummaryComponent } from "../../src/transforms/turn-work-summary.mjs";

const { initTheme } = await import(pathToFileURL(`${senpiDir}/dist/modes/interactive/theme/theme.js`).href);
const { stripAnsi } = await import(pathToFileURL(`${senpiDir}/dist/utils/ansi.js`).href);
const { ToolExecutionComponent } = await import(
  pathToFileURL(`${senpiDir}/dist/modes/interactive/components/tool-execution.js`).href
);
const { AssistantMessageComponent } = await import(
  pathToFileURL(`${senpiDir}/dist/modes/interactive/components/assistant-message.js`).href
);

try {
  initTheme("dark", false);
} catch {
  // Theme is a process singleton.
}

const ui = { requestRender() {} };

function tool(name, args, text, isError = false) {
  const component = new ToolExecutionComponent(name, "t" + Math.random(), args, {}, undefined, ui, process.cwd());
  component.setArgsComplete();
  component.updateResult({ content: [{ type: "text", text }], details: {}, isError });
  return component;
}

function actionUrl(lines) {
  return lines.join("\n").match(/\x1b\]8;;([^\x1b\x07]+)/)?.[1];
}

test("internal-actions register and dispatch", () => {
  let count = 0;
  const registration = registerInternalAction(() => {
    count += 1;
  });
  assert.match(registration.url, /^senpi-action:\d+$/);
  assert.equal(dispatchInternalAction(registration.url), true);
  assert.equal(count, 1);
  assert.equal(dispatchInternalAction("https://example.com"), false);
  registration.dispose();
  assert.equal(dispatchInternalAction(registration.url), true);
  assert.equal(count, 1);
});

test("tool-group folds consecutive tools and keeps UNGROUPED_TOOLS verbatim", () => {
  // Semantic: vendor tool-group.js is a created file, so byte equality is impossible.
  assert.deepEqual([...UNGROUPED_TOOLS], ["task", "team_create", "todo"]);
  for (const name of ["task", "team_create", "todo"]) {
    assert.equal(ToolGroupComponent.canGroup(name), false);
  }
  for (const name of ["ls", "read", "grep", "bash", "edit", "write", "eval"]) {
    assert.equal(ToolGroupComponent.canGroup(name), true);
  }

  const group = new ToolGroupComponent(ui);
  group.addTool(tool("ls", { path: "harness" }, "a\nb\nc"));
  group.addTool(tool("read", { path: "src/a.ts" }, "x\ny"));
  group.addTool(tool("bash", { command: "npm run build" }, "ok"));
  const lines = group.render(92);
  assert.equal(lines.length, 1);
  const text = stripAnsi(lines.join(""));
  assert.match(text, /• 3 tools/);
  assert.doesNotMatch(text, /⋯/);
  assert.match(text, /ls/);
  assert.match(text, /read/);
  assert.match(text, /bash/);
  group.dispose();
});

test("tool-group click expands, failed names stay on one line, repeats count", () => {
  const group = new ToolGroupComponent(ui);
  group.addTool(tool("ls", { path: "harness" }, "alpha\nbeta\ngamma"));
  const collapsed = group.render(92);
  assert.equal(collapsed.length, 1);
  assert.doesNotMatch(stripAnsi(collapsed.join("\n")), /alpha/);
  dispatchInternalAction(actionUrl(collapsed));
  const expanded = stripAnsi(group.render(92).join("\n"));
  assert.match(expanded, /alpha/);
  assert.match(expanded, /gamma/);
  group.dispose();

  const failed = new ToolGroupComponent(ui);
  failed.addTool(tool("ls", { path: "." }, "a"));
  failed.addTool(tool("bash", { command: "bun test" }, "FAIL\nexpected 200 got 500", true));
  const raw = failed.render(92).join("");
  assert.equal(failed.render(92).length, 1);
  assert.equal(raw.match(/\x1b\[38;2;196;116;110m([^\x1b]+)/)?.[1], "bash");
  failed.dispose();

  const counted = new ToolGroupComponent(ui);
  for (const input of ["a", "b", "c", "d"]) counted.addTool(tool("apply_patch", { input }, "ok"));
  counted.addTool(tool("bash", { command: "bun test" }, "ok"));
  counted.addTool(tool("apply_patch", { input: "e" }, "ok"));
  const countedText = stripAnsi(counted.render(92).join(""));
  assert.match(countedText, /6 tools/);
  assert.match(countedText, /apply_patch \(4\)/);
  counted.dispose();
});

test("SKILL.md read and git bash stay ungrouped; late skill splits the group", () => {
  assert.equal(isSkillRead("read", { path: "/Users/wy/.agents/skills/keep-simple/SKILL.md" }), true);
  assert.equal(ToolGroupComponent.canGroup("read", { path: "src/a.ts" }), true);
  assert.equal(isGitWork("bash", { command: "git status" }), true);
  assert.equal(isGitWork("bash", { command: "GIT_DIR=.git git commit -m x" }), true);
  assert.equal(isGitWork("bash", { command: "sudo git push" }), true);
  assert.equal(isGitWork("bash", { command: "bun test" }), false);

  const children = [];
  const group = new ToolGroupComponent(ui);
  children.push(group);
  const ls = tool("ls", { path: "." }, "a");
  const skill = tool("read", { path: "src/a.ts" }, "x");
  const grep = tool("grep", { pattern: "x" }, "hit");
  group.addTool(ls);
  group.addTool(skill);
  group.addTool(grep);
  skill.updateArgs({ path: "skills/keep-simple/SKILL.md" });
  const next = group.extractAt(skill, children, () => new ToolGroupComponent(ui));
  assert.equal(children.length, 3);
  assert.equal(children[0], group);
  assert.equal(children[1], skill);
  assert.equal(children[2], next);
  assert.equal(group.size, 1);
  assert.deepEqual(group.tools, [ls]);
  assert.equal(next?.size, 1);
  assert.deepEqual(next?.tools, [grep]);
  group.dispose();
  next?.dispose();
});

test("turn-work summary collapses thinking+tools and respects width / aggregation", () => {
  // Semantic: vendor turn-work-summary.js is a created file.
  const startedAt = Date.now() - 47_000;
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "숨긴 사고", startedAt, endedAt: startedAt + 47_000 }],
    timestamp: startedAt,
    stopReason: "stop",
  };
  const assistant = new AssistantMessageComponent(message, true);
  const tools = new ToolGroupComponent(ui);
  for (let i = 0; i < 15; i++) tools.addTool(tool("read", { path: `f${i}` }, `result-${i}`));
  tools.addTool(tool("bash", { command: "bun test" }, "FAIL", true));
  const summary = new TurnWorkSummaryComponent(ui);
  summary.trackAssistant(assistant, message);
  summary.trackToolGroup(tools);

  assert.deepEqual(assistant.render(100), []);
  assert.deepEqual(tools.render(100), []);
  const collapsed = summary.render(100);
  const collapsedText = stripAnsi(collapsed.join(""));
  assert.match(collapsedText, /• Worked 1 step · thought 47s · 16 tools:/);
  assert.match(collapsedText, /✓ read \(15\)/);
  assert.match(collapsedText, /✗ bash/);

  dispatchInternalAction(actionUrl(collapsed));
  assert.match(stripAnsi(assistant.render(100).join("\n")), /Thought: 47\.0s/);
  assert.match(stripAnsi(tools.render(100).join("\n")), /16 tools/);
  summary.dispose();
  tools.dispose();
  assistant.dispose();
});

test("turn-work summary aggregates mixed tool names and stays within width", () => {
  const tools = new ToolGroupComponent(ui);
  const names = ["eval", "grep", "eval", "grep", "eval", "read", "eval", "grep", "read"];
  for (const [i, name] of names.entries()) {
    tools.addTool(tool(name, {}, "ok"));
  }
  tools.addTool(tool("eval", {}, "FAIL", true));
  const summary = new TurnWorkSummaryComponent(ui);
  summary.trackToolGroup(tools);
  const line = stripAnsi(summary.render(160).join(""));
  assert.match(line, /• Worked 0 steps · 10 tools:/);
  assert.match(line, /✓ eval \(4\)/);
  assert.match(line, /✓ grep \(3\)/);
  assert.match(line, /✓ read \(2\)/);
  assert.match(line, /✗ eval/);

  const wide = new ToolGroupComponent(ui);
  for (let i = 0; i < 20; i++) wide.addTool(tool(`tool-${i}`, {}, "ok"));
  const wideSummary = new TurnWorkSummaryComponent(ui);
  wideSummary.trackToolGroup(wide);
  const clipped = stripAnsi(wideSummary.render(60).join(""));
  assert.ok([...clipped].length <= 60);
  assert.match(clipped, /^• Worked 0 steps · 20 tools:/);
  assert.match(clipped, /…\+/);
  summary.dispose();
  tools.dispose();
  wideSummary.dispose();
  wide.dispose();
});


test("progress hide after complete, final remains, hideTurnWork stays thinking-only", () => {
  const commentary = JSON.stringify({ v: 1, id: "c", phase: "commentary" });
  const finalAnswer = JSON.stringify({ v: 1, id: "f", phase: "final_answer" });
  const hidden = [];
  const assistant = {
    hideProgress: false,
    turnWorkCollapsed: false,
    setTurnWorkCollapsed(value) { this.turnWorkCollapsed = value; },
    setHideProgress(value) { this.hideProgress = value; hidden.push(value); },
  };
  const progressMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret", startedAt: 1, endedAt: 2 },
      { type: "text", text: "working on it", textSignature: commentary },
      { type: "text", text: "here is the answer", textSignature: finalAnswer },
    ],
    stopReason: "stop",
    timestamp: 1,
  };
  const summary = new TurnWorkSummaryComponent(ui);
  summary.trackAssistant(assistant, progressMessage);
  assert.equal(assistant.hideProgress, false, "progress stays visible while running");
  summary.setRequestCompleted(true, "completed");
  assert.equal(assistant.hideProgress, true);
  assert.equal(assistant.turnWorkCollapsed, true);
  const line = stripAnsi(summary.render(120).join(""));
  assert.match(line, /update/);
  summary.setExpanded(true);
  assert.equal(assistant.hideProgress, false, "expand reveals folded progress");
  summary.dispose();
});
