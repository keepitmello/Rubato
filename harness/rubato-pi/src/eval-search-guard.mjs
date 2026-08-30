// eval 셀이 레포 탐색을 파이썬 순회로 재구현할 때 한 번 찔러준다.
//
// 이 하네스는 grep/find/ls 도구가 비활성이다(엔진이 코딩 세트를 read/bash/edit/write
// 로만 준다). 역할 프롬프트의 base.pi.md 가 "bash 의 rg, ast_grep_search,
// lsp_find_references 를 쓰라"고 안내하지만, 프롬프트 한 줄은 셀을 쓰는 순간에는
// 멀리 있다. 실제로 이 세션에서도 안내가 있는 채로 os.listdir 로 디렉터리를 훑었다.
//
// 그래서 프롬프트가 아니라 행동에 붙인다. 위반한 그 자리에서 도구 이름을 되돌려주는
// 편이 문장을 더 넣는 것보다 싸고 정확하다.
//
// 세 가지를 지킨다:
//   - 순회로 "탐색"을 하는 경우만 잡는다. 파일 하나 열기, 경로 조작, 메타데이터
//     처리는 정당한 용도라 건드리지 않는다.
//   - 세션당 한 번만 말한다. 매번 붙으면 소음이 되고 무시하는 법을 배운다.
//   - 결과를 바꾸지 않는다. 뒤에 한 문단 덧붙일 뿐이라 셀 출력은 그대로다.

// 파일시스템을 걸어 다니는 신호.
const TRAVERSAL = [
  /\brglob\s*\(/,
  /\bos\.walk\s*\(/,
  /\bos\.listdir\s*\(/,
  /\bglob\.glob\s*\(/,
  /\bglob\.iglob\s*\(/,
  /\bPath\([^)]*\)\.glob\s*\(/,
  /\bfs\.readdirSync\s*\(/,
  /\bfs\.promises\.readdir\s*\(/,
  /\breaddirSync\s*\(/,
];

// 그 순회가 "내용을 뒤지는" 쪽으로 이어지는 신호. 순회만으로는 부족하다 —
// 파일 개수를 세거나 mtime 을 보는 것은 도구로 대체되지 않는 진짜 용도다.
const CONTENT_PROBE = [
  /\bread_text\s*\(/,
  // read(p) / read(d + f) / read(os.path.join(...)) — 인자가 식이어도 잡는다.
  // 문자열 리터럴 하나만 넘기는 read('src/main.zig') 는 순회와 무관한 단일 읽기라
  // 여기서 제외된다(따옴표로 시작하지 않는 인자만 본다).
  /\bread\s*\(\s*[^)'"`]/,
  /\breadFileSync\s*\(/,
  /\bopen\s*\(/,
  /\bin\s+f\.read\b/,
  /\.count\s*\(/,
  /\bre\.(search|findall|finditer|match)\s*\(/,
  /\.includes\s*\(/,
  /\.split\s*\(\s*["'`]\\n/,
];

const REMINDER = [
  "[rubato] 이 셀이 파일시스템을 직접 걸어 다니며 내용을 뒤졌다.",
  "이 하네스에는 grep/find/ls 도구가 없지만, 그 일에는 더 나은 수단이 있다:",
  "",
  "  - 내용 검색:   bash 의 `rg` (설치돼 있다)",
  "  - 경로 찾기:   bash 의 `find`",
  "  - 구조 검색:   ast_grep_search (텍스트 아닌 AST 매칭)",
  "  - 호출자 추적: lsp_find_references",
  "  - 범위 읽기:   read 의 offset/limit",
  "",
  "eval 은 이것들을 parallel 로 묶고 결과를 줄이는 자리지, 검색을 다시 구현하는 자리가 아니다.",
  "파일 메타데이터나 개수처럼 순회가 진짜 필요한 일이었다면 이 알림은 무시해도 된다.",
].join("\n");

export function looksLikeRepoSearch(code) {
  if (typeof code !== "string" || code.length === 0) return false;
  if (!TRAVERSAL.some((re) => re.test(code))) return false;
  return CONTENT_PROBE.some((re) => re.test(code));
}

export function installEvalSearchGuard(pi, { reminder = REMINDER } = {}) {
  let warned = false;

  pi.on("tool_result", (event) => {
    if (warned) return undefined;
    if (event?.toolName !== "eval") return undefined;
    if (event.isError) return undefined;

    const code = event.input?.code;
    if (!looksLikeRepoSearch(code)) return undefined;

    warned = true;
    return {
      content: [...(event.content ?? []), { type: "text", text: `\n\n${reminder}` }],
    };
  });
}
