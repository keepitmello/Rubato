import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { injectSessionDate, isSessionDateUrl } from "../../src/transforms/misc-session-date.mjs";

const DATE_ASSIGNMENT = "(buildDynamicSystemPrompt.sessionDate ??= new Date().toISOString().slice(0, 10))";

function withFakeUtcDate(iso, fn) {
  const RealDate = Date;
  const frozen = new RealDate(iso);
  function FakeDate(...args) {
    if (new.target) {
      return args.length === 0 ? new RealDate(frozen) : new RealDate(...args);
    }
    return RealDate();
  }
  FakeDate.now = () => frozen.getTime();
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = /** @type {typeof Date} */ (FakeDate);
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

function loadPatchedDateReader(patched) {
  assert.ok(patched.includes(DATE_ASSIGNMENT), "patched source must memoize the session date");
  return new Function(`
    function buildDynamicSystemPrompt() {
      return ${DATE_ASSIGNMENT};
    }
    return buildDynamicSystemPrompt;
  `)();
}

test("session date transform applies once and freezes the date across midnight", () => {
  const source = readFileSync(join(senpiDir, "dist/core/dynamic-prompt/build.js"), "utf8");
  assert.match(source, /const date = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  const next = injectSessionDate(source);
  assert.match(next, /const date = \(buildDynamicSystemPrompt\.sessionDate \?\?= new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\);/);
  assert.doesNotMatch(next, /const date = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  assert.throws(() => injectSessionDate(next));
  assert.equal(
    isSessionDateUrl("file:///x/@code-yeongyu/senpi/dist/core/dynamic-prompt/build.js"),
    true,
  );
  assert.equal(
    isSessionDateUrl("file:///x/@code-yeongyu/senpi/dist/core/system-prompt.js"),
    false,
  );

  const readDate = loadPatchedDateReader(next);
  const first = withFakeUtcDate("2026-09-05T23:00:00.000Z", () => readDate());
  const second = withFakeUtcDate("2026-09-06T12:00:00.000Z", () => readDate());
  assert.equal(first, "2026-09-05");
  assert.equal(second, first);
});
