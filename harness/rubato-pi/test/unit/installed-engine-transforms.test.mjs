// 설치본 엔진 위에서 로더 체인이 온전히 적용되는지 검증하는 상시 가드.
//
// depatch 이후 node_modules 는 pristine 이고, 예전 벤더 패치의 행동은 전부
// load transform 이 싣는다. 그러니 여기 나열된 파일 하나하나에서
//   (1) 변환이 실제로 일어나고 (source 가 바뀌고)
//   (2) 드리프트 경고가 하나도 없어야
// 지금 설치본이 핀과 일치하는 것이다. 엔진 버전을 올려 니들이 어긋나면
// 이 테스트가 가장 먼저 무너진다 — 그때 고칠 곳은 transforms/ 다.
//
// 목록은 depatch 시점의 감사 인벤토리(구 flip-readiness)에서 온다. 패치가
// 만들던 신규 벤더 파일(tool-group, turn-work-summary, internal-actions,
// cursor-exec-journal)은 in-repo 모듈이 정본이라 여기 없다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { load } from "../../src/no-changelog-hooks.mjs";

const ROOTS = {
  senpi: (rel) => join(senpiDir, rel),
  "senpi-tui": (rel) => senpiNested("@earendil-works", "pi-tui", rel),
  "pi-ai": (rel) => senpiNested("@earendil-works", "pi-ai", rel),
};

const AUDITED = [
  ["senpi", "dist/core/agent-session.js"],
  ["senpi", "dist/core/extensions/builtin/compaction/speculative.js"],
  ["senpi", "dist/modes/interactive/components/assistant-message.js"],
  ["senpi", "dist/modes/interactive/components/tool-execution.js"],
  ["senpi", "dist/modes/interactive/interactive-mode.js"],
  ["senpi", "dist/modes/interactive/components/progressive-transcript-container.js"],
  ["senpi", "dist/core/extensions/builtin/service-tier.js"],
  ["senpi", "dist/core/compaction/stream-watchdog.js"],
  ["senpi", "dist/modes/interactive/components/model-selector.js"],
  ["senpi", "dist/core/high-reasoning-warning.js"],
  ["senpi", "dist/core/compaction/compaction.js"],
  ["senpi", "dist/core/auth-storage.js"],
  ["senpi", "dist/core/cursor-exec-bridge-session.js"],
  ["senpi", "dist/core/cursor-exec-bridge.js"],
  ["senpi", "dist/modes/interactive/components/assistant-render-descriptors.js"],
  ["senpi", "dist/core/slash-commands.js"],
  ["senpi", "dist/core/extensions/loader.js"],
  ["senpi", "dist/core/extensions/runner.js"],
  ["senpi", "dist/core/provider-timeout-retry.js"],
  ["senpi", "dist/modes/interactive/extension-error-format.js"],
  ["senpi", "dist/modes/interactive/components/settings-selector.js"],
  ["senpi-tui", "dist/autocomplete.js"],
  ["senpi-tui", "dist/components/editor.js"],
  ["senpi-tui", "dist/dollar-invocation-autocomplete.js"],
  ["senpi-tui", "dist/slash-command-autocomplete.js"],
  ["senpi-tui", "dist/terminal.js"],
  ["senpi-tui", "dist/tui-alt-screen.js"],
  ["pi-ai", "dist/api/anthropic-messages.js"],
  ["pi-ai", "dist/api/lazy.js"],
  ["pi-ai", "dist/api/transform-messages.js"],
  ["pi-ai", "dist/api/google-shared.js"],
  ["pi-ai", "dist/api/cursor-agent.js"],
  ["pi-ai", "dist/api/cursor-conversation-rotation.js"],
  ["pi-ai", "dist/utils/prompt-cache-ttl.js"],
  ["pi-ai", "dist/utils/overflow.js"],
];

test("every audited vendor file transforms cleanly on the installed engine", async () => {
  const warnings = [];
  const onWarning = (warning) => {
    if (warning?.name === "RubatoTransformDrift") warnings.push(warning.message);
  };
  process.on("warning", onWarning);
  try {
    for (const [alias, rel] of AUDITED) {
      const path = ROOTS[alias](rel);
      const source = readFileSync(path, "utf8");
      const url = pathToFileURL(path).href;
      const result = await load(url, { format: "module" }, async () => ({ format: "module", source }));
      assert.notEqual(
        String(result.source),
        source,
        `${alias}:${rel} was not transformed at all - a needle set went inert`,
      );
    }
    // process.emitWarning 은 비동기로 전달된다. 한 틱 기다렸다가 판정한다.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, [], "transform drift on the installed engine");
  } finally {
    process.off("warning", onWarning);
  }
});
