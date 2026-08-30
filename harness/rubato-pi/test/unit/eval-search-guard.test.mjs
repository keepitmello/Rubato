import test from "node:test";
import assert from "node:assert/strict";
import { installEvalSearchGuard, looksLikeRepoSearch } from "../../src/eval-search-guard.mjs";

function fakePi() {
  const handlers = new Map();
  return {
    on: (name, fn) => handlers.set(name, fn),
    emit: (name, event) => handlers.get(name)?.(event),
  };
}

function evalResult(code, extra = {}) {
  return {
    type: "tool_result",
    toolName: "eval",
    toolCallId: "t1",
    input: { code },
    content: [{ type: "text", text: "ok" }],
    isError: false,
    ...extra,
  };
}

test("순회로 내용을 뒤지는 셀을 잡는다", () => {
  const cases = [
    "for p in Path('src').rglob('*.ts'):\n    hits[p.name] = p.read_text().count('legacyClient')",
    "import os\nfor root, dirs, files in os.walk('src'):\n    for f in files:\n        open(os.path.join(root,f)).read()",
    "for f in os.listdir(d):\n    print(read(d+f))",
    "const files = fs.readdirSync('src'); files.forEach(f => fs.readFileSync(f).includes('TODO'))",
    "for p in Path('.').glob('**/*.py'):\n    if re.search('def main', p.read_text()): print(p)",
  ];
  for (const code of cases) {
    assert.ok(looksLikeRepoSearch(code), `잡았어야 한다:\n${code}`);
  }
});

test("순회가 정당한 용도면 잡지 않는다", () => {
  const cases = [
    // 개수·메타데이터 — 도구로 대체되지 않는다
    "print(len(os.listdir('src')))",
    "for p in Path('src').rglob('*.ts'):\n    total += p.stat().st_size",
    "files = fs.readdirSync('.'); console.log(files.length)",
    // 순회 없이 파일 하나 읽기
    "print(read('src/main.zig'))",
    "content = open('/tmp/x').read()",
    // 도구를 제대로 쓴 셀
    "display(parallel([lambda: tool.bash({'command': 'rg legacyClient src'})]))",
    "tool.read({'path': 'a.ts', 'offset': 10, 'limit': 40})",
    "",
  ];
  for (const code of cases) {
    assert.ok(!looksLikeRepoSearch(code), `잡지 말았어야 한다:\n${code}`);
  }
});

test("잡으면 원래 출력 뒤에 알림을 덧붙인다", () => {
  const pi = fakePi();
  installEvalSearchGuard(pi);
  const out = pi.emit("tool_result", evalResult("for p in Path('.').rglob('*.ts'): p.read_text().count('x')"));

  assert.ok(out?.content, "결과를 반환해야 한다");
  assert.equal(out.content[0].text, "ok", "원래 출력은 그대로 앞에 남는다");
  assert.match(out.content.at(-1).text, /rg/);
  assert.match(out.content.at(-1).text, /ast_grep_search/);
  assert.match(out.content.at(-1).text, /lsp_find_references/);
});

test("세션당 한 번만 말한다", () => {
  const pi = fakePi();
  installEvalSearchGuard(pi);
  const code = "for p in Path('.').rglob('*.ts'): p.read_text().count('x')";

  assert.ok(pi.emit("tool_result", evalResult(code)), "첫 번째는 알린다");
  assert.equal(pi.emit("tool_result", evalResult(code)), undefined, "두 번째부터는 조용하다");
  assert.equal(pi.emit("tool_result", evalResult(code)), undefined);
});

test("eval 이 아니거나 실패한 셀은 건드리지 않는다", () => {
  const pi = fakePi();
  installEvalSearchGuard(pi);
  const code = "for p in Path('.').rglob('*.ts'): p.read_text().count('x')";

  assert.equal(pi.emit("tool_result", evalResult(code, { toolName: "bash" })), undefined);
  assert.equal(pi.emit("tool_result", evalResult(code, { isError: true })), undefined);
  assert.equal(pi.emit("tool_result", { type: "tool_result", toolName: "eval", input: {} }), undefined);
});
