import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { senpiDir } from "../../src/engine-paths.mjs";
import { load } from "../../src/no-changelog-hooks.mjs";

// 이 하네스는 NODE_OPTIONS 로 로더를 심어 두기 때문에, 그 로더가 던지면
// 그러면 그 Node 프로세스 전체가 죽는다 — `senpi --help` 조차.
// 설치된 senpi 가 레포 핀과 다른 버전이면(전역 설치, 오래된 클론, 부분 업데이트)
// 주입 앵커가 안 맞는 것은 **정상**이다. 그때 잃어야 하는 것은 그 꾸밈 하나지,
// CLI 전체가 아니다.

const interactiveUrl = "file:///x/node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js";
const assistantUrl = "file:///x/node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js";
const editorUrl = "file:///x/node_modules/pi-tui/dist/components/editor.js";

function loaderFor(source) {
  return (url, context) => ({ format: "module", source, shortCircuit: true });
}

async function runLoad(url, source) {
  return await load(url, {}, loaderFor(source));
}

test("a drifted assistant-message still loads", async () => {
  const result = await runLoad(assistantUrl, "export class AssistantMessage {}\n");
  assert.equal(String(result.source), "export class AssistantMessage {}\n");
});

test("a drifted pi-tui editor still loads", async () => {
  const result = await runLoad(editorUrl, "export class Editor {}\n");
  assert.equal(String(result.source), "export class Editor {}\n");
});

