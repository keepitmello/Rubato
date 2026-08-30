// 상류 프롬프트 표류 감시.
//
// 우리는 customPrompt 를 쓰지 않는다. 엔진이 시스템 프롬프트를 다 만들게 두고
// extractHarnessExtras 의 정규식 다섯 개로 필요한 조각만 뜯어 재조립한다. 그래서
// 상류가 블록을 추가하면 정규식이 모르는 채로 조용히 사라진다 — 에러도 로그도 없이.
//
// 실제로 두 번 샜다. 스킬 목록은 재생성 코드로 땜빵했고,
// "Use bash for file operations like ls, rg, find" 는 grep/find/ls 가 비활성인
// 이 조합에서만 엔진이 넣어주던 한 줄인데 몇 달 사라진 줄 몰랐다. 그동안 세션은
// 탐색 도구를 안내받지 못해 os.walk 같은 파이썬 순회로 레포를 훑었다
// (2026-08-22, 역할 프롬프트의 base.pi.md 에 복원).
//
// 이 테스트는 엔진이 만든 프롬프트를 블록으로 쪼개고, 우리 산출물이 각 블록을
// 건졌는지/의도적으로 버렸는지 대조한다. 알려진 목록에 없는 블록이 나오면 터진다.
// 터졌을 때 할 일은 스냅샷을 맞추는 것이 아니라 결정을 내리는 것이다:
// 새 블록을 버릴지, 역할 프롬프트 조각에 우리 문장으로 넣을지, extras 로 건질지.
// 정하고 나서 아래 목록에 사유와 함께 적는다.

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { extractHarnessExtras, loadRolePrompt } from "../../src/system-prompt.mjs";
import { senpiSystemPromptModule } from "../../src/engine-paths.mjs";

// senpi 의 package.json exports 가 하위 경로를 막아서 require.resolve 로는 못 뚫는다.
// 레포의 다른 테스트들과 같은 방식으로 dist 를 직접 가리킨다.
const ENGINE_SYSTEM_PROMPT = senpiSystemPromptModule;

async function loadEngineBuilder() {
  const mod = await import(pathToFileURL(ENGINE_SYSTEM_PROMPT).href);
  return mod.buildSystemPrompt;
}

// 엔진 기본 프롬프트가 만드는 블록. 각 항목은 프롬프트에서 그 블록을 식별하는
// 지문(probe)과, 우리가 그것을 어떻게 처리하는지의 근거다.
//
//   keep = extractHarnessExtras 가 건진다. 사라지면 회귀다.
//   drop = 의도적으로 버린다. 역할 프롬프트 조각이 더 나은 판을 이미 갖고 있다.
const ENGINE_BLOCKS = [
  {
    probe: "You are an expert coding assistant",
    fate: "drop",
    why: "base.pi.md 의 Working agreement 가 대체한다",
  },
  {
    probe: "Available tools:",
    fate: "drop",
    why: "도구 스키마는 API 로 따로 간다. 프롬프트 목록은 중복이다",
  },
  {
    probe: "you may have access to other custom tools",
    fate: "drop",
    why: "위 Available tools 목록의 꿀리. 목록을 버렸으니 같이 버린다",
  },
  {
    probe: "Use bash for file operations like ls, rg, find",
    fate: "drop",
    why: "base.pi.md 가 rg/ast_grep_search/lsp_find_references 까지 넣은 확장판을 갖는다. 이 줄이 사라진 것을 몇 달 몰랐던 것이 이 테스트를 만든 이유다",
  },
  {
    probe: "Be concise in your responses",
    fate: "drop",
    why: "voice 조각이 더 구체적으로 말한다",
  },
  {
    probe: "Show file paths clearly when working with files",
    fate: "drop",
    why: "voice 조각이 경로를 언제 말할지까지 정한다",
  },
  {
    probe: "Pi documentation",
    fate: "drop",
    why: "pi 자체를 물을 때만 쓰이고, base.pi.md 가 공개 Rubato 정본을 가리킨다",
  },
  {
    probe: "<project_context",
    fate: "keep",
    why: "프로젝트 지시. 우리 것이 아니므로 반드시 실어 나른다",
  },
  {
    probe: "The following skills provide specialized instructions",
    fate: "keep",
    why: "없으면 세션이 어떤 스킬이 있는지 못 본다. 한 번 샜던 자리다",
  },
  {
    probe: "Current working directory:",
    fate: "keep",
    why: "런타임 컨텍스트",
  },
];

function buildEngineDefault(buildSystemPrompt) {
  return buildSystemPrompt({
    // 우리 실제 구성: grep/find/ls 는 비활성이고 bash 가 있다.
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: {
      read: "read a file",
      bash: "run a command",
      edit: "edit a file",
      write: "write a file",
    },
    cwd: "/tmp/rubato-drift",
    contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
    skills: [{ name: "demo", description: "demo skill", filePath: "/tmp/demo/SKILL.md" }],
  });
}

test("엔진 기본 프롬프트에 우리가 모르는 블록이 생기지 않았다", async () => {
  const buildSystemPrompt = await loadEngineBuilder();
  const engine = buildEngineDefault(buildSystemPrompt);

  // 엔진 산출물을 문단으로 쪼개고, 알려진 지문 중 어느 것도 가리키지 않는
  // 문단이 있으면 상류가 뭔가 새로 넣은 것이다.
  const known = ENGINE_BLOCKS.map((block) => block.probe);
  // <project_context> 같은 XML 블록은 안에 빈 줄이 있어서 문단 분할이 가른다.
  // 하나의 블록으로 접어둔 뒤 쪼개야 안쪽 조각이 가짜 미지로 잡히지 않는다.
  const collapsed = engine.replace(/<project_context>[\s\S]*?<\/project_context>/g, "<project_context/>");
  const unknown = collapsed
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .filter((chunk) => !known.some((probe) => chunk.includes(probe)))
    // 목록 이어짐(불릿, 경로 줄)은 앞 블록의 꼬리라 따로 세지 않는다.
    .filter((chunk) => !/^[-*|\d]/.test(chunk));

  assert.deepEqual(
    unknown,
    [],
    `상류 Senpi 가 시스템 프롬프트에 새 블록을 추가했다. 버릴지 역할 프롬프트에 넣을지 정하고 ENGINE_BLOCKS 에 사유와 함께 적어라:\n\n${unknown.join("\n---\n")}`,
  );
});

test("keep 으로 표시한 블록은 extras 로 실제로 건져진다", async () => {
  const buildSystemPrompt = await loadEngineBuilder();
  const engine = buildEngineDefault(buildSystemPrompt);
  const extras = extractHarnessExtras(engine).join("\n\n");

  for (const block of ENGINE_BLOCKS.filter((b) => b.fate === "keep")) {
    assert.ok(
      extras.includes(block.probe),
      `"${block.probe}" 는 keep 인데 extractHarnessExtras 가 놓쳤다 (${block.why})`,
    );
  }
});

test("drop 으로 표시한 블록은 재조립 결과에 섞이지 않는다", async () => {
  const buildSystemPrompt = await loadEngineBuilder();
  const engine = buildEngineDefault(buildSystemPrompt);
  const extras = extractHarnessExtras(engine).join("\n\n");

  for (const block of ENGINE_BLOCKS.filter((b) => b.fate === "drop")) {
    assert.ok(
      !extras.includes(block.probe),
      `"${block.probe}" 는 drop 인데 extras 에 딸려 들어왔다. 정규식이 너무 넓다`,
    );
  }
});

// drop 은 "버려도 된다"가 아니라 "우리 판이 이미 있다"는 주장이다. 그 주장이
// 참인지는 역할 프롬프트 조각을 봐야 안다 — 여기서 확인하지 않으면 역할 프롬프트에서 문장이
// 지워졌을 때 drop 근거가 조용히 거짓이 된다. 그게 rg 줄에서 일어난 일이다.
test("탐색 도구 안내는 역할 프롬프트 조각에 살아 있다", () => {
  for (const role of ["lead", "teammate"]) {
    const text = loadRolePrompt(role);
    assert.match(
      text,
      /Search with the tools built for it/,
      `${role} 역할 프롬프트에 탐색 도구 안내가 없다. 엔진도 안 넣고 역할 프롬프트도 없으면 세션은 파이썬 순회로 레포를 훑는다`,
    );
    for (const probe of ["rg", "ast_grep_search", "lsp_find_references"]) {
      assert.ok(text.includes(probe), `${role} 역할 프롬프트가 ${probe} 를 안내하지 않는다`);
    }
  }
});
