import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { senpiDir } from "../../src/engine-paths.mjs";
import { injectAuthStorage } from "../../src/transforms/misc-auth-storage.mjs";

const authStoragePath = join(senpiDir, "dist", "core", "auth-storage.js");
const installed = readFileSync(authStoragePath, "utf8");

/** 넓힌 fs import 없이 헬퍼만 들어간 파일은 첫 자격증명 쓰기에서 죽는다. */
function callsOpenSyncWithoutImporting(source) {
  const calls = /\bopenSync\(/.test(source);
  const imports = /import \{[^}]*\bopenSync\b[^}]*\} from "fs";/.test(source);
  return calls && !imports;
}

test("the pinned engine takes the whole atomic auth write", () => {
  const next = injectAuthStorage(installed);
  assert.match(next, /function atomicWriteAuthFileSync/);
  assert.match(next, /import \{[^}]*\bopenSync\b[^}]*\} from "fs";/);
  assert.equal(callsOpenSyncWithoutImporting(next), false);
});

test("a drifted fs import drops the transform instead of half-applying it", () => {
  // 전역 설치본(2026.8.18-2)과 같은 모양: import 줄에 chmodSync 가 하나 더 있어
  // FS_NEEDLE 만 빗나가고 나머지 니들은 그대로 맞는다.
  const drifted = installed.replace(
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";',
    'import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";',
  );
  assert.notEqual(drifted, installed, "이 테스트는 pinned import 줄을 전제로 한다");
  assert.throws(() => injectAuthStorage(drifted), /auth fs import for atomicWriteAuthFileSync/);
});

test("write sites never call a helper that was not injected", () => {
  // 헬퍼 자리는 어긋났는데 write 자리는 맞는 판. 가드가 없으면 없는 함수를 부르는
  // 파일이 나온다. write 자리는 pinned 판에서 이미 어긋나 있으므로 여기서 되살린다.
  const helperSiteMoved = installed
    .replace(
      'const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 };\nlet sharedAuthFileReadState;',
      'const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 };\nlet sharedAuthFileReadStateRenamed;',
    )
    .replace(
      '            writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);\n',
      '            writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);\n            chmodSync(this.authPath, 0o600);\n',
    );
  assert.match(helperSiteMoved, /sharedAuthFileReadStateRenamed/, "이 테스트는 pinned 헬퍼 자리를 전제로 한다");
  assert.throws(() => injectAuthStorage(helperSiteMoved), /atomicWriteAuthFileSync for ensureFileExists write/);
});

// 지금 pinned 판(2026.9.4-3)에서 실제로 벌어지는 일을 고정해 둔다: 헬퍼는 들어가지만
// 세 write 자리 니들이 모두 빗나가 아무도 그것을 부르지 않는다. auth.json 쓰기는
// 여전히 원자적이지 않다. 이 테스트는 그 상태를 승인하는 것이 아니라 눈에 보이게 한다.
test("[known drift] pinned write sites no longer match, so the helper is unused", () => {
  const next = injectAuthStorage(installed);
  assert.match(next, /function atomicWriteAuthFileSync/);
  assert.doesNotMatch(next, /atomicWriteAuthFileSync\(this\.authPath/);
});

test("an already patched source stays valid on a second pass", () => {
  const once = injectAuthStorage(installed);
  const twice = injectAuthStorage(once);
  assert.equal(twice, once);
  assert.equal(callsOpenSyncWithoutImporting(twice), false);
});
