import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { senpiDir } from "../../src/engine-paths.mjs";
import { injectInteractiveModeChrome } from "../../src/transforms/interactive-mode-chrome.mjs";
import {
  THINKING_LABEL,
  WORKING_LABEL,
  nextWorkingLabel,
  shouldClearWorkingOnAgentEnd,
} from "../../src/transforms/working-phase.mjs";

const thinking = (text) => ({ type: "thinking", thinking: text });
const say = (text) => ({ type: "text", text });
const call = (name) => ({ type: "toolCall", id: "t1", name, arguments: {} });

test("빈 메시지는 국면을 바꾸지 않는다", () => {
  assert.equal(nextWorkingLabel(undefined), undefined);
  assert.equal(nextWorkingLabel({ content: [] }), undefined);
});

test("사고만 왔으면 Thinking, 말이나 도구가 나오면 Working", () => {
  assert.equal(nextWorkingLabel({ content: [thinking("음")] }), THINKING_LABEL);
  assert.equal(nextWorkingLabel({ content: [thinking("음"), say("결론은")] }), WORKING_LABEL);
  assert.equal(nextWorkingLabel({ content: [thinking("음"), call("bash")] }), WORKING_LABEL);
});

test("스트림이 방금 연 빈 말 블록은 앞의 사고가 국면을 정한다", () => {
  assert.equal(nextWorkingLabel({ content: [thinking("음"), say("")] }), THINKING_LABEL);
});

test("도구 결과 뒤에 다시 사고가 붙으면 Thinking 으로 돌아간다", () => {
  const content = [thinking("먼저"), call("bash"), thinking("결과를 보니")];
  assert.equal(nextWorkingLabel({ content }), THINKING_LABEL);
});

test("재시도가 예정됐거나 대기 입력이 있으면 독을 접지 않는다", () => {
  assert.equal(shouldClearWorkingOnAgentEnd({ willRetry: false }, 0), true);
  assert.equal(shouldClearWorkingOnAgentEnd({}, 0), true);
  assert.equal(shouldClearWorkingOnAgentEnd({ willRetry: true }, 0), false);
  assert.equal(shouldClearWorkingOnAgentEnd({ willRetry: false }, 1), false);
});

test("설치된 엔진에 세 자리가 모두 걸린다", () => {
  const source = readFileSync(
    join(senpiDir, "dist/modes/interactive/interactive-mode.js"),
    "utf8",
  );
  const next = injectInteractiveModeChrome(source);
  assert.match(next, /case "turn_start":[\s\S]{0,400}?this\.workingMessage = THINKING_LABEL;/);
  assert.match(next, /const workingLabel = nextWorkingLabel\(event\.message\);/);
  assert.match(
    next,
    /shouldClearWorkingOnAgentEnd\(event, this\.pendingUserInputs\.length\)\)\n\s*this\.clearStatusIndicator\("working"\);/,
  );
  assert.match(next, /case "agent_idle":[\s\S]{0,400}?this\.clearStatusIndicator\("working"\);/);
});
