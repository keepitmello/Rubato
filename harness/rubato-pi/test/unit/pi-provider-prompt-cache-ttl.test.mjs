import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const OWNED = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2", "owned", "dist", "utils", "prompt-cache-ttl.js");
const STOCK_AI = "/tmp/pi-provider-st_01a0729f/stock-pi-ai";

test("owned prompt-cache-ttl keeps GPT-5.6 1800s for Codex Responses", async () => {
  assert.equal(existsSync(OWNED), true);
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-ttl-")), "pkg");
  cpSync(STOCK_AI, pkgDir, { recursive: true });
  cpSync(join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2", "owned"), pkgDir, { recursive: true });
  const { resolvePromptCacheTtlSeconds, PROMPT_CACHE_TTL_GPT56_SECONDS } = await import(
    pathToFileURL(join(pkgDir, "dist", "utils", "prompt-cache-ttl.js")).href
  );
  assert.equal(PROMPT_CACHE_TTL_GPT56_SECONDS, 1800);
  assert.equal(
    resolvePromptCacheTtlSeconds({ id: "gpt-5.6-terra", api: "openai-codex-responses" }),
    1800,
  );
  assert.equal(
    resolvePromptCacheTtlSeconds({ id: "gpt-4.1", api: "openai-codex-responses" }),
    300,
  );
});
