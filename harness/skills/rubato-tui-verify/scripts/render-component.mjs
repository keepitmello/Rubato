#!/usr/bin/env node
// senpi TUI 컴포넌트를 실제로 렌더해서 화면 문자열을 찍는다.
//
// 세션을 띄우지 않고 렌더링을 확인하는 자리. 토큰을 쓰지 않고 0.3초에 끝난다.
// 로더 변환(collapsible-mouse 등)이 걸린 실물이 필요하므로 반드시
// `--import <레포>/harness/rubato-pi/src/no-changelog-register.mjs` 와 함께 돈다.
//
//   node --import .../no-changelog-register.mjs render-component.mjs --demo thinking
//
// 옵션:
//   --demo <thinking|text>  내장 시나리오
//   --width <n>             렌더 폭 (기본 60)
//   --expand                사고 블록을 펼친 뒤 렌더
//   --raw                   이스케이프를 지우지 않고 그대로 (링크 확인용)
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const repo = process.env.RUBATO_REPO ?? join(process.env.HOME, "Github-repos", "Rubato");
const { senpiDir } = await import(pathToFileURL(join(repo, "harness/rubato-pi/src/engine-paths.mjs")).href);

// 테마가 없으면 사고 라벨을 그리다가 던진다.
const { initTheme } = await import(pathToFileURL(join(senpiDir, "dist/modes/interactive/theme/theme.js")).href);
try { initTheme("dark"); } catch { /* 이미 초기화됨 */ }

const { AssistantMessageComponent } = await import(
  pathToFileURL(join(senpiDir, "dist/modes/interactive/components/assistant-message.js")).href
);
const { dispatchInternalAction } = await import(
  pathToFileURL(join(senpiDir, "dist/modes/interactive/internal-actions.js")).href
);

const width = Number(arg("width", 60));
const demo = arg("demo", "thinking");
const started = Date.now();

// stopReason 이 없으면 디스크립터 빌더가 assertNever 로 던진다.
const message = demo === "text"
  ? { role: "assistant", content: [{ type: "text", text: "본문 한 줄" }], timestamp: started, stopReason: "stop" }
  : {
      role: "assistant",
      content: [{ type: "thinking", thinking: "첫 조각\n둘째 조각", startedAt: started, endedAt: started + 1200 }],
      timestamp: started,
      stopReason: "stop",
    };

const component = new AssistantMessageComponent(message, true);

if (has("expand")) {
  // 라벨의 OSC8 링크가 펼침 토글이다. 줄 0 은 셸 통합 마커라 고정 인덱스를 쓰지 않는다.
  const linkRe = new RegExp("\\x1b\\]8;;(senpi-action:\\d+)\\x1b\\\\", "g");
  const url = component.render(width)
    .flatMap((line) => [...line.matchAll(linkRe)].map((m) => m[1]))
    .find(Boolean);
  if (!url) {
    console.error("펼칠 토글 링크를 못 찾았다 — 접힘 상태가 아니거나 렌더 구조가 바뀌었다");
    process.exit(1);
  }
  dispatchInternalAction(url);
}

const osc = new RegExp("\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)", "g");
const sgr = new RegExp("\\x1b\\[[0-9;]*m", "g");
const strip = (s) => s.replace(osc, "").replace(sgr, "");
for (const [i, line] of component.render(width).entries()) {
  console.log(String(i).padStart(2), has("raw") ? JSON.stringify(line) : strip(line));
}
