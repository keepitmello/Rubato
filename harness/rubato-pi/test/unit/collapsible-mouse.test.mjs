import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { nodeChildEnv, resolveNodeExecutable } from "../helpers/node-executable.mjs";
import {
  actionLineMarker,
  injectCollapsibleAssistant,
  injectCollapsibleMouseRouting,
  injectCollapsibleToolExecution,
  injectCollapsibleToolGroup,
  isCollapsibleAssistantUrl,
  isCollapsibleToolExecutionUrl,
  isCollapsibleToolGroupUrl,
} from "../../src/collapsible-mouse.mjs";

const componentsDir = join(senpiDir, "dist/modes/interactive/components");
const assistantPath = join(componentsDir, "assistant-message.js");
const toolExecutionPath = join(componentsDir, "tool-execution.js");
const toolGroupPath = join(componentsDir, "tool-group.js");
const altScreenPath = join(senpiNested("@earendil-works/pi-tui/dist"), "tui-alt-screen.js");
const senpiPrefix = "file:///repo/node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/";
const registerHref = new URL("../../src/no-changelog-register.mjs", import.meta.url).href;
const thisFile = fileURLToPath(import.meta.url);
const runtime = process.env.RUBATO_COLLAPSIBLE_MOUSE_RUNTIME === "1";

if (!runtime) test("URL matching targets only the three collapsible Senpi components", () => {
  assert.equal(isCollapsibleAssistantUrl(`${senpiPrefix}assistant-message.js`), true);
  assert.equal(isCollapsibleToolExecutionUrl(`${senpiPrefix}tool-execution.js`), true);
  assert.equal(isCollapsibleToolGroupUrl(`${senpiPrefix}tool-group.js`), true);
  assert.equal(isCollapsibleAssistantUrl(`${senpiPrefix}assistant-render-descriptors.js`), false);
  assert.equal(isCollapsibleToolExecutionUrl("file:///x/pi-tui/dist/tui-alt-screen.js"), false);
});

if (!runtime) test("transforms apply to real installed sources and are idempotent", () => {
  const assistant = readFileSync(assistantPath, "utf8");
  const toolExecution = readFileSync(toolExecutionPath, "utf8");
  const toolGroup = readFileSync(toolGroupPath, "utf8");
  const altScreen = readFileSync(altScreenPath, "utf8");
  const assistantNext = injectCollapsibleAssistant(assistant);
  const toolExecutionNext = injectCollapsibleToolExecution(toolExecution);
  const toolGroupNext = injectCollapsibleToolGroup(toolGroup);
  const altScreenNext = injectCollapsibleMouseRouting(altScreen);

  assert.notEqual(assistantNext, assistant);
  assert.notEqual(toolExecutionNext, toolExecution);
  assert.notEqual(toolGroupNext, toolGroup);
  assert.notEqual(altScreenNext, altScreen);
  assert.match(assistantNext, /RubatoThinkingMarkdown/);
  assert.match(toolExecutionNext, /if \(this\.expanded\)/);
  assert.match(toolGroupNext, /super\.render\(width\)\.map/);
  assert.match(altScreenNext, /getRubatoCollapseUrl\(this\.getSelectionSourceLine\(anchor\)\)/);
  assert.ok(
    altScreenNext.indexOf("getOsc8LinkAtColumn(this.previousScreen") < altScreenNext.indexOf("getRubatoCollapseUrl(this.getSelectionSourceLine(anchor))"),
    "ordinary links take precedence over the whole-line collapse fallback",
  );
  assert.equal(injectCollapsibleAssistant(assistantNext), assistantNext);
  assert.equal(injectCollapsibleToolExecution(toolExecutionNext), toolExecutionNext);
  assert.equal(injectCollapsibleToolGroup(toolGroupNext), toolGroupNext);
  assert.equal(injectCollapsibleMouseRouting(altScreenNext), altScreenNext);
});

if (!runtime) test("transforms fail loudly on installed-source drift", () => {
  const assistant = readFileSync(assistantPath, "utf8");
  const toolExecution = readFileSync(toolExecutionPath, "utf8");
  const toolGroup = readFileSync(toolGroupPath, "utf8");
  const altScreen = readFileSync(altScreenPath, "utf8");
  assert.throws(
    () => injectCollapsibleAssistant(assistant.replace("return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme, {", "return new Markdown(descriptor.text, 1, 0, this.markdownTheme, {")),
    /transform drift: thinking markdown/,
  );
  assert.throws(
    () => injectCollapsibleToolExecution(toolExecution.replace("if (!this.isExpanded) {", "if (this.isExpanded === false) {")),
    /transform drift: expanded tool lines/,
  );
  assert.throws(
    () => injectCollapsibleToolGroup(toolGroup.replace("if (this.expanded) return super.render(width);", "if (this.expanded) return this.renderTools(width);")),
    /transform drift: expanded tool group/,
  );
  assert.throws(
    () => injectCollapsibleMouseRouting(altScreen.replace("const wordSegmenter = getWordSegmenter();", "const wordSegmenter = new Intl.Segmenter();")),
    /transform drift: routing helper/,
  );
});

if (!runtime) test("expanded-line marker is zero-width OSC8 metadata with no visible styling", async () => {
  const tuiDist = senpiNested("@earendil-works/pi-tui/dist");
  const { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } = await import(join(tuiDist, "utils.js"));
  const marker = actionLineMarker("senpi-action:42");
  const line = marker + "thinking body";
  assert.equal(stripTerminalSequences(line), "thinking body");
  assert.equal(visibleWidth(line), 13);
  assert.equal(getOsc8LinkAtColumn(line, 0), undefined);
});

if (!runtime) test("loader-transformed real components collapse from expanded body clicks and preserve drag selection", () => {
  const result = spawnSync(resolveNodeExecutable(), ["--import", registerHref, "--test", thisFile], {
    env: nodeChildEnv({ RUBATO_COLLAPSIBLE_MOUSE_RUNTIME: "1" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

if (runtime) test("expanded thinking body is clickable while a drag copies without collapsing", async () => {
  assert.equal(process.env.NODE_OPTIONS, "");
  const { initTheme } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/theme/theme.js")).href);
  try { initTheme("dark"); } catch { /* already initialized */ }
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?collapse=${Date.now()}`);
  const { dispatchInternalAction } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href);
  const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?collapse=${Date.now()}`);
  const { getOsc8LinkAtColumn } = await import(pathToFileURL(join(senpiNested("@earendil-works/pi-tui/dist"), "utils.js")).href);
  const started = Date.now();
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "first body line\nsecond body line", startedAt: started, endedAt: started + 1200 }],
    timestamp: started,
    stopReason: "stop",
  };
  const component = new AssistantMessageComponent(message, true);
  const collapsed = component.render(40);
  const actionUrl = collapsed
    .flatMap((line) => [...line.matchAll(/\x1b\]8;;(senpi-action:\d+)/g)].map((m) => m[1]))
    .find(Boolean);
  assert.match(actionUrl ?? "", /^senpi-action:\d+$/);
  dispatchInternalAction(actionUrl);
  const expanded = component.render(40);
  assert.ok(expanded.length >= 2);
  assert.match(expanded.join("\n"), /\x1b\]8;;senpi-action:\d+/);

  let copied = 0;
  const terminal = {
    rows: 20,
    columns: 40,
    write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
  };
  const tui = new TuiAltScreen(terminal, false, undefined, {
    openUrl: dispatchInternalAction,
    copySelection: async () => { copied += 1; return true; },
  });
  tui.previousScreen = expanded;
  tui.handleSelectionMouseEvent({ button: 0, x: 5, y: 1, release: false });
  tui.handleSelectionMouseEvent({ button: 3, x: 5, y: 1, release: true });
  assert.deepEqual(component.render(40), collapsed);

  dispatchInternalAction(actionUrl);
  tui.previousScreen = component.render(40);
  tui.handleSelectionMouseEvent({ button: 0, x: 1, y: 0, release: false });
  tui.handleSelectionMouseEvent({ button: 32, x: 6, y: 1, release: false });
  tui.handleSelectionMouseEvent({ button: 3, x: 6, y: 1, release: true });
  await Promise.resolve();
  assert.ok(component.render(40).length >= 2, "drag must leave thinking expanded");
  assert.equal(copied, 1);
});
