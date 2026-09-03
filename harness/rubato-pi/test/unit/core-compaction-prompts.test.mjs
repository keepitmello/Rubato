import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  FABLE_51_PRESERVATION_GUIDANCE,
  SOURCE_CONTEXT_TURN_PREFIX_PROMPT_NEEDLE,
  SUMMARIZATION_PROMPT_NEEDLE,
  TURN_PREFIX_PROMPT_NEEDLE,
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

// 공식 원문(계획서) — 상수가 이것과 바이트 단위로 같아야 한다.
const OFFICIAL_GUIDANCE_HEAD = "Summarize the transcript inside `<summary></summary>` tags. Include relevant information in the summary such that this conversation will be continued by a new context window without needing to redo work or be reprovided with relevant constraints or context.";

test("핀된 compaction.js 바늘이 맞고 Fable 5.1 지침으로 교체된다", () => {
  const source = pinned("dist/core/compaction/compaction.js");
  assert.equal(source.includes(SUMMARIZATION_PROMPT_NEEDLE), true, "SUMMARIZATION_PROMPT needle");
  assert.equal(source.includes(UPDATE_SUMMARIZATION_INSTRUCTIONS_NEEDLE), true, "UPDATE_SUMMARIZATION_INSTRUCTIONS needle");
  assert.equal(source.includes(TURN_PREFIX_PROMPT_NEEDLE), true, "TURN_PREFIX_SUMMARIZATION_PROMPT needle");
  assert.equal(source.includes(SOURCE_CONTEXT_TURN_PREFIX_PROMPT_NEEDLE), true, "SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT needle");

  const next = injectCompaction(source);
  assert.equal(FABLE_51_PRESERVATION_GUIDANCE.startsWith(OFFICIAL_GUIDANCE_HEAD), true, "guidance is verbatim (backticks included)");
  assert.equal(countLiteral(constValue(next, "SUMMARIZATION_PROMPT"), FABLE_51_PRESERVATION_GUIDANCE), 1);
  assert.equal(countLiteral(constValue(next, "UPDATE_SUMMARIZATION_INSTRUCTIONS"), FABLE_51_PRESERVATION_GUIDANCE), 1);
  assert.equal(countLiteral(constDecl(next, "TURN_PREFIX_SUMMARIZATION_PROMPT"), FABLE_51_PRESERVATION_GUIDANCE), 0);
  assert.equal(countLiteral(constDecl(next, "SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT"), FABLE_51_PRESERVATION_GUIDANCE), 0);

  const fullSummary = constDecl(next, "SUMMARIZATION_PROMPT");
  const updateBody = constDecl(next, "UPDATE_SUMMARIZATION_INSTRUCTIONS");
  assert.doesNotMatch(fullSummary, /## Goal/);
  assert.doesNotMatch(fullSummary, /Use this EXACT format/);
  assert.doesNotMatch(updateBody, /## Goal/);
  assert.doesNotMatch(updateBody, /Use this EXACT format/);
  assert.match(constDecl(next, "TURN_PREFIX_SUMMARIZATION_PROMPT"), /## Original Request/);
  assert.match(constDecl(next, "SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT"), /## Original Request/);
  assert.match(next, /The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags\./);
  assert.match(next, /The messages above contain an existing structured summary of earlier conversation history followed by NEW conversation messages\./);
  assert.match(next, /unwrapOuterSummary\(contentTextForSummary\(/);

  assert.throws(() => injectCompaction(next));
  assert.equal(isCompactionUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/compaction.js"), true);
  assert.equal(isCompactionUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/utils.js"), false);
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
