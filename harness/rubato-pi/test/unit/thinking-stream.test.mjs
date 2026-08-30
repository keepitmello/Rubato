// 사고가 "접힌 채로 들어오고, 펼치면 그 안에서 자란다" 를 고정한다.
//
// b9285ece5 에서 hideThinkingBlock 을 false 로 뒤집었다가 되돌린 적이 있다.
// 그때 놓친 것은 산문이 새는지가 아니라 펼친 안쪽이 실제로 갱신되는지였다.
// 여기서는 델타를 한 조각씩 먹여 가며 접힘/펼침 양쪽을 같이 본다.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { nodeChildEnv, resolveNodeExecutable } from "../helpers/node-executable.mjs";

const assistantPath = join(senpiDir, "dist/modes/interactive/components/assistant-message.js");
const registerHref = new URL("../../src/no-changelog-register.mjs", import.meta.url).href;
const thisFile = fileURLToPath(import.meta.url);
const runtime = process.env.RUBATO_THINKING_STREAM_RUNTIME === "1";

// 로더 변환이 걸린 실제 컴포넌트가 필요하므로 자식 프로세스로 한 번 더 들어간다.
if (!runtime) test("thinking streams inside the expanded block on the real component", () => {
  // 테스트 파일 안에서 --test 를 다시 부르면 node 가 재귀라고 보고 건너뛴다.
  // 그냥 파일을 실행하면 test() 가 독립으로 돌며 TAP 을 찍는다.
  // 부모가 물려준 리포터가 상속되지 않게 spec 으로 고정하고 집계를 직접 센다.
  const result = spawnSync(resolveNodeExecutable(), ["--import", registerHref, "--test-reporter=spec", thisFile], {
    env: nodeChildEnv({ RUBATO_THINKING_STREAM_RUNTIME: "1" }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
  });
  // status 만 보면 자식이 통째로 안 돌아도 통과한다. 실제로 몇 개가 지나갔는지 센다.
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const passed = Number(/(?:^|\s)pass (\d+)/m.exec(output)?.[1] ?? -1);
  const failed = Number(/(?:^|\s)fail (\d+)/m.exec(output)?.[1] ?? -1);
  assert.ok(passed >= 7, `자식 테스트가 덜 돌았다(pass=${passed}):\n${output}`);
  assert.equal(failed, 0, output);
});

// 실제 컴포넌트는 테마 없이는 사고 라벨을 못 그린다.
async function initThemeOnce() {
  const { initTheme } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/theme/theme.js")).href);
  try { initTheme("dark"); } catch { /* 이미 초기화됨 */ }
}

const WIDTH = 60;
const visible = (lines) => lines.join("\n").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

// 끝난 사고를 접어 둔 상태에서는 델타가 더 와도 산문이 새면 안 된다.
// 사고가 흐르는 중의 기본값은 펼침이므로, 접힘을 보려면 손으로 접은 뒤를 본다.
if (runtime) test("collapsed thinking never leaks prose while deltas arrive", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const { dispatchInternalAction } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href);
  // 빈 thinking 은 디스크립터가 아예 안 생기므로 첫 조각부터 채워서 시작한다.
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "첫 번째 단서를 본다", startedAt: Date.now() }], timestamp: Date.now(), stopReason: "stop" };
  const component = new AssistantMessageComponent(message, true);

  // 손으로 접는다. 이 override 가 이후 델타 내내 유지되어야 한다.
  const actionUrl = component.render(WIDTH)
    .flatMap((line) => [...line.matchAll(/\x1b\]8;;(senpi-action:\d+)\x1b\\/g)].map((m) => m[1]))
    .find(Boolean);
  dispatchInternalAction(actionUrl);

  const chunks = ["두 번째로 좁힌다", "결론에 도달한다"];
  let acc = "첫 번째 단서를 본다";
  for (const chunk of chunks) {
    acc += "\n" + chunk;
    message.content[0].thinking = acc;
    component.updateContent(message, true);
    const text = visible(component.render(WIDTH));
    for (const seen of acc.split("\n")) {
      assert.ok(!text.includes(seen), `접힌 상태에서 사고 산문이 샜다: ${seen}`);
    }
  }
});

if (runtime) test("expanded thinking grows with each delta", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const { dispatchInternalAction } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href);
  const { getOsc8LinkAtColumn } = await import(pathToFileURL(join(senpiNested("@earendil-works/pi-tui/dist"), "utils.js")).href);

  // 이미 끝난 사고로 시작한다 — 자동 판정이 접어 두므로 손으로 펴는 경로를 볼 수 있다.
  const started = Date.now();
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "첫 조각", startedAt: started, endedAt: started + 900 }], timestamp: started, stopReason: "stop" };
  const component = new AssistantMessageComponent(message, true);

  // 라벨의 OSC8 링크가 펼침 토글이다. 줄 0 은 쉘 통합 마커라 고정 인덱스를 쓰지 않는다.
  const actionUrl = component.render(WIDTH)
    .flatMap((line) => [...line.matchAll(/\x1b\]8;;(senpi-action:\d+)\x1b\\/g)].map((m) => m[1]))
    .find(Boolean);
  assert.match(actionUrl ?? "", /^senpi-action:\d+$/, "사고 라벨에 토글 링크가 없다");
  dispatchInternalAction(actionUrl);

  assert.ok(visible(component.render(WIDTH)).includes("첫 조각"), "펼쳤는데 첫 조각이 안 보인다");

  // 펼친 상태를 유지한 채 델타를 계속 먹인다.
  const chunks = ["두 번째 조각", "세 번째 조각", "마지막 조각"];
  let acc = "첫 조각";
  let previousLength = visible(component.render(WIDTH)).length;
  for (const chunk of chunks) {
    acc += "\n" + chunk;
    message.content[0].thinking = acc;
    component.updateContent(message, true);
    const text = visible(component.render(WIDTH));
    assert.ok(text.includes(chunk), `펼친 안쪽이 갱신되지 않았다: ${chunk}`);
    assert.ok(text.includes("첫 조각"), "이전 사고가 사라졌다");
    assert.ok(text.length > previousLength, "펼친 본문이 자라지 않았다");
    previousLength = text.length;
  }

  // 다시 누르면 접히고, 접힌 뒤에는 산문이 남지 않는다.
  dispatchInternalAction(actionUrl);
  const collapsed = visible(component.render(WIDTH));
  assert.ok(!collapsed.includes("마지막 조각"), "접었는데 산문이 남았다");
});

if (runtime) test("thinking stays collapsed by default and the label is the toggle", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const started = Date.now();
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "숨어 있어야 하는 사고", startedAt: started, endedAt: started + 1200 }],
    timestamp: started, stopReason: "stop",
  };
  const component = new AssistantMessageComponent(message, true);
  const text = visible(component.render(WIDTH));
  assert.ok(!text.includes("숨어 있어야 하는 사고"), "기본값이 접힘이 아니다");
  assert.match(text, /Thought:/, "접힌 상태에서 라벨이 없다");
});

// 사고의 수명이 곧 펼침의 수명이다: 흐르는 동안 펼쳐져 있고, 끝나면 접힌다.
if (runtime) test("thinking auto-expands while streaming and collapses when it ends", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const started = Date.now();
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "첫 조각", startedAt: started }],
    timestamp: started, stopReason: "stop",
  };
  const component = new AssistantMessageComponent(message, true);

  // 사고가 흐르는 동안: 손 안 대도 안쪽이 보이고 델타마다 자란다.
  assert.ok(visible(component.render(WIDTH)).includes("첫 조각"), "스트리밍 중인데 기본이 접힘이다");
  let previousLength = visible(component.render(WIDTH)).length;
  for (const chunk of ["두 번째 조각", "세 번째 조각"]) {
    message.content[0].thinking += "\n" + chunk;
    component.updateContent(message, true);
    const text = visible(component.render(WIDTH));
    assert.ok(text.includes(chunk), `펼친 안쪽이 갱신되지 않았다: ${chunk}`);
    assert.ok(text.length > previousLength, "펼친 본문이 자라지 않았다");
    previousLength = text.length;
  }

  // endedAt 이 찍히는 순간 접힌다. 라벨만 남고 산문은 사라진다.
  message.content[0].endedAt = started + 1200;
  component.updateContent(message, true);
  const collapsed = visible(component.render(WIDTH));
  assert.ok(!collapsed.includes("세 번째 조각"), "사고가 끝났는데 접히지 않았다");
  assert.match(collapsed, /Thought:/, "접힌 뒤 라벨이 없다");
});

// 손으로 누른 것은 자동 판정을 이긴다 — 안 그러면 스트리밍 중 접어도 곧바로 되펴진다.
if (runtime) test("a manual toggle overrides the automatic lifecycle", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const { dispatchInternalAction } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href);
  const started = Date.now();
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "첫 조각", startedAt: started }],
    timestamp: started, stopReason: "stop",
  };
  const component = new AssistantMessageComponent(message, true);

  const actionUrl = component.render(WIDTH)
    .flatMap((line) => [...line.matchAll(/\x1b\]8;;(senpi-action:\d+)\x1b\\/g)].map((m) => m[1]))
    .find(Boolean);
  assert.match(actionUrl ?? "", /^senpi-action:\d+$/, "펼친 사고에도 라벨 토글이 있어야 한다");

  // 흐르는 중에 손으로 접는다. 이후 델타가 와도 접힌 채여야 한다.
  dispatchInternalAction(actionUrl);
  message.content[0].thinking += "\n두 번째 조각";
  component.updateContent(message, true);
  const text = visible(component.render(WIDTH));
  assert.ok(!text.includes("두 번째 조각"), "손으로 접었는데 자동 판정이 되폈다");

  // 사고가 끝난 뒤 손으로 펴면 펼쳐진 채로 남는다.
  message.content[0].endedAt = started + 1200;
  component.updateContent(message, true);
  dispatchInternalAction(actionUrl);
  assert.ok(visible(component.render(WIDTH)).includes("두 번째 조각"), "끝난 뒤 펼친 것이 유지되지 않았다");
});

// 한 메시지 안에 사고 런이 여럿일 때(도구 호출 사이에 다시 생각) 접힘은 런 단위여야 한다.
// 불리언 하나로 두면 뒤 런이 흐를 때 이미 끝난 앞 런의 산문까지 같이 펴진다.
if (runtime) test("each thinking run collapses on its own lifecycle", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const t0 = Date.now();
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "첫 사고", startedAt: t0, endedAt: t0 + 500 },
    { type: "toolCall", id: "1", name: "read", arguments: {} },
  ], timestamp: t0, stopReason: "stop" };
  const component = new AssistantMessageComponent(message, true);
  assert.ok(!visible(component.render(WIDTH)).includes("첫 사고"), "끝난 첫 런이 접히지 않았다");

  message.content.push({ type: "thinking", thinking: "둘째 사고", startedAt: t0 + 1000 });
  component.updateContent(message, true);
  const text = visible(component.render(WIDTH));
  assert.ok(text.includes("둘째 사고"), "새로 시작한 런이 펼쳐지지 않았다");
  assert.ok(!text.includes("첫 사고"), "이미 끝난 앞 런이 뒤 런 때문에 되폈다");
});

// 앞 런에서 누른 선택이 뒤 런을 짓누르면 새 사고가 통째로 안 보인다.
if (runtime) test("a manual toggle does not leak into the next thinking run", async () => {
  await initThemeOnce();
  const { AssistantMessageComponent } = await import(`${pathToFileURL(assistantPath).href}?stream=${Date.now()}`);
  const { dispatchInternalAction } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href);
  const t0 = Date.now();
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "첫 사고", startedAt: t0 }], timestamp: t0, stopReason: "stop" };
  const component = new AssistantMessageComponent(message, true);

  const actionUrl = component.render(WIDTH)
    .flatMap((line) => [...line.matchAll(/\x1b\]8;;(senpi-action:\d+)\x1b\\/g)].map((m) => m[1]))
    .find(Boolean);
  dispatchInternalAction(actionUrl); // 흐르는 1번 런을 손으로 접는다
  assert.ok(!visible(component.render(WIDTH)).includes("첫 사고"), "손으로 접히지 않았다");

  // 1번이 끝나고 도구를 거쳐 2번 런이 시작된다.
  message.content[0].endedAt = t0 + 500;
  message.content.push({ type: "toolCall", id: "1", name: "read", arguments: {} });
  message.content.push({ type: "thinking", thinking: "둘째 사고", startedAt: t0 + 1000 });
  component.updateContent(message, true);
  assert.ok(visible(component.render(WIDTH)).includes("둘째 사고"), "앞 런의 선택이 뒤 런을 막았다");
});
