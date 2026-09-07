// MCP 도구 이름의 `mcp__` 접두를 고정한다.
//
// 왜 이 시험이 있나: Anthropic OAuth wire 는 도구 이름이 `mcp_` 로 시작하되 `mcp__`
// 가 아니면 요청을 Claude Code 가 아닌 third-party 앱으로 판정하고, 추가 사용량이
// 꺼진 계정에서 요청 전체를 400 으로 거절한다. 즉 접두 하나가 세션을 통째로 죽인다.
// 그래서 문자열 단정으로 끝내지 않고 패치한 모듈을 실제로 평가해 이름을 받아 본다.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import {
  injectMcpProxyToolName,
  injectMcpToolNamePrefix,
  isMcpNamingUrl,
  isMcpProxyUrl,
} from "../../src/transforms/core-tool-surface.mjs";

const NAMING = join(senpiDir, "dist/core/extensions/builtin/mcp/expose/naming.js");
const PROXY = join(senpiDir, "dist/core/extensions/builtin/mcp/expose/proxy.js");

test("url matchers pick the MCP naming/proxy files only", () => {
  assert.equal(isMcpNamingUrl(pathToFileURL(NAMING).href), true);
  assert.equal(isMcpProxyUrl(pathToFileURL(PROXY).href), true);
  assert.equal(isMcpNamingUrl(pathToFileURL(PROXY).href), false);
  assert.equal(isMcpProxyUrl(pathToFileURL(NAMING).href), false);
});

test("MCP 도구 이름이 홑밑줄 접두를 남기지 않는다", async () => {
  const pristine = readFileSync(NAMING, "utf8");
  const patched = injectMcpToolNamePrefix(pristine);
  assert.notEqual(patched, pristine);
  // 니들이 사라졌으므로 두 번째 적용은 drift 로 throw 한다.
  assert.throws(() => injectMcpToolNamePrefix(patched));

  const dir = mkdtempSync(join(tmpdir(), "rubato-mcp-naming-"));
  const file = join(dir, "naming.mjs");
  writeFileSync(file, patched);
  const { buildMcpToolName, buildMcpToolNames } = await import(pathToFileURL(file).href);

  // 컴퓨터유즈 MCP(`cua_repl` 서버의 `js`)가 이 버그를 처음 드러낸 이름이다.
  assert.equal(buildMcpToolName({ serverName: "cua_repl", toolName: "js" }), "mcp__cua_repl_js");
  // serverName 이 비어 이미 밑줄 두 개로 시작하던 이름은 그대로여야 한다.
  assert.equal(buildMcpToolName({ serverName: "", toolName: "ast_grep_search" }), "mcp__ast_grep_search");

  const names = buildMcpToolNames([
    { serverName: "cua_repl", toolName: "js" },
    { serverName: "cua_repl", toolName: "js_reset" },
    { serverName: "", toolName: "ast_grep_search" },
  ]);
  for (const name of names) {
    assert.ok(name.startsWith("mcp__"), `${name} 이 Claude Code 접두를 벗어났다`);
  }
});

test("proxy gateway 이름도 같은 접두를 쓴다", async () => {
  const pristine = readFileSync(PROXY, "utf8");
  const patched = injectMcpProxyToolName(pristine);
  assert.notEqual(patched, pristine);
  assert.throws(() => injectMcpProxyToolName(patched));
  assert.ok(patched.includes("const name = `mcp__${String(server)"));
  assert.equal(patched.includes('named[0]?.name.split("_").slice(0, 2)'), false);
});
