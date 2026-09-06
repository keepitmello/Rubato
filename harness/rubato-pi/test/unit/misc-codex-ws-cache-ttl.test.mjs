import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  injectCodexWsCacheTtl,
  isCodexWsCacheTtlUrl,
} from "../../src/transforms/misc-codex-ws-cache-ttl.mjs";

test("실제 엔진 소스에 WS cache TTL 패치가 걸리고 두 번 걸면 던진다", () => {
  const source = readFileSync(
    senpiNested("@earendil-works/pi-ai/dist/api/openai-codex-responses.js"),
    "utf8",
  );
  assert.match(source, /const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(source, /\}, SESSION_WEBSOCKET_CACHE_TTL_MS\);/);
  assert.doesNotMatch(source, /idleTimer\.unref/);
  const next = injectCodexWsCacheTtl(source);
  assert.match(next, /const SESSION_WEBSOCKET_CACHE_TTL_MS = 30 \* 60 \* 1000;/);
  assert.doesNotMatch(next, /const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(next, /entry\.idleTimer\.unref\?\.\(\);/);
  assert.throws(() => injectCodexWsCacheTtl(next));
  assert.equal(
    isCodexWsCacheTtlUrl("file:///x/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"),
    true,
  );
  assert.equal(
    isCodexWsCacheTtlUrl("file:///x/@earendil-works/pi-ai/dist/api/openai-codex-responses.lazy.js"),
    false,
  );
});
