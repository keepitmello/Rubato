import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { COMPACTION_BRIEFING_GUIDANCE } from "../../src/compaction-guidance.mjs";
import {
  SUMMARIZATION_PROMPT_NEEDLE,
  UPDATE_SUMMARIZATION_INSTRUCTIONS_NEEDLE,
  injectCompaction,
  isCompactionUrl,
  unwrapOuterSummary,
} from "../../src/transforms/core-compaction.mjs";
import {
  SUMMARIZATION_SYSTEM_PROMPT_NEEDLE,
  injectCompactionUtils,
  isCompactionUtilsUrl,
} from "../../src/transforms/core-compaction-utils.mjs";

function pinned(rel) {
  return readFileSync(join(senpiDir, rel), "utf8");
}

function countLiteral(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

function constDecl(source, name) {
  const prefix = `const ${name} = \``;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `missing const ${name}`);
  // 이스케이프된 백틱(\`) 은 닫는 백틱이 아니다.
  let end = start + prefix.length;
  while (true) {
    end = source.indexOf("`;", end);
    assert.notEqual(end, -1, `unclosed const ${name}`);
    if (source[end - 1] !== "\\") break;
    end += 1;
  }
  return source.slice(start, end + 2);
}

/** 선언을 실제 JS 로 평가해 런타임 문자열을 얻는다 — 소스의 이스케이프와 무관하게 원문과 비교한다. */
function constValue(source, name) {
  const decl = constDecl(source, name);
  return new Function(`${decl}; return ${name};`)();
}

test("핀된 compaction.js 의 요약 프롬프트는 인계 지침으로 바뀜다", () => {
  const source = pinned("dist/core/compaction/compaction.js");
  // TURN_PREFIX 계열 니들은 senpi 2026.9.4-3 핀에 없다(드리프트, 별도 정리 대상) — 여기서는 지침이 실제로 들어가는 두 니들만 본다.
  for (const needle of [SUMMARIZATION_PROMPT_NEEDLE, UPDATE_SUMMARIZATION_INSTRUCTIONS_NEEDLE]) {
    assert.equal(countLiteral(source, needle), 1, `needle: ${needle.slice(0, 40)}`);
  }
  const next = injectCompaction(source);
  // 런타임 문자열이 정본과 바이트 단위로 같아야 한다 (이스케이프가 문구를 바꾸면 안 된다).
  assert.equal(constValue(next, "SUMMARIZATION_PROMPT").endsWith(COMPACTION_BRIEFING_GUIDANCE), true);
  assert.equal(constValue(next, "UPDATE_SUMMARIZATION_INSTRUCTIONS").endsWith(COMPACTION_BRIEFING_GUIDANCE), true);
  assert.match(COMPACTION_BRIEFING_GUIDANCE, /^You are writing the briefing that the next worker will start from/);
  assert.doesNotMatch(next, /Use this EXACT format/);
  assert.equal(isCompactionUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/compaction.js"), true);
});

test("핀된 utils.js 시스템 프롬프트는 <summary> 전용으로 바뀐다", () => {
  const source = pinned("dist/core/compaction/utils.js");
  assert.equal(source.includes(SUMMARIZATION_SYSTEM_PROMPT_NEEDLE), true, "SUMMARIZATION_SYSTEM_PROMPT needle");
  const next = injectCompactionUtils(source);
  assert.match(next, /produce a summary inside <summary><\/summary> tags and nothing else/);
  assert.doesNotMatch(next, /produce a structured summary following the exact format specified/);
  assert.throws(() => injectCompactionUtils(next));
  assert.equal(isCompactionUtilsUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/utils.js"), true);
  assert.equal(isCompactionUtilsUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/compaction.js"), false);
});

test("unwrapOuterSummary 는 바깥 <summary> 한 겹만 벗긴다", () => {
  assert.equal(unwrapOuterSummary("<summary>hello</summary>"), "hello");
  assert.equal(unwrapOuterSummary("hello"), "hello");
  assert.equal(unwrapOuterSummary("  \n<summary>\n  hello\n</summary>\n  "), "hello");
});
