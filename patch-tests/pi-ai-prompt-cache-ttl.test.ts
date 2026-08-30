// GPT-5.6+ Responses/Codex prompt-cache TTL: 30 minutes, earlier models stay at 5 minutes.
//
// Senpi's safe-wait subtracts `promptCache.safetyBufferSeconds` (Rubato policy: 5 minutes)
// from that TTL. This file hits the **live nested** pi-ai copy, then the Senpi budget helper
// that the agent session actually calls.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePromptCacheSafeWaitSeconds } from "../node_modules/@code-yeongyu/senpi/dist/core/prompt-cache-budget.js";
import { ANTHROPIC_MODELS } from "../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/providers/anthropic.models.js";
import { OPENAI_CODEX_MODELS } from "../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.models.js";
import { OPENAI_MODELS } from "../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/providers/openai.models.js";
import {
  PROMPT_CACHE_TTL_GPT56_SECONDS,
  PROMPT_CACHE_TTL_LONG_SECONDS,
  PROMPT_CACHE_TTL_SHORT_SECONDS,
  resolvePromptCacheTtlSeconds,
} from "../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/prompt-cache-ttl.js";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, stackByFile } from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const SERIES_NAME = "@earendil-works%2Fpi-ai";
const TTL_REL = "dist/utils/prompt-cache-ttl.js";
const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === SERIES_NAME)!;
const RUBATO_SAFETY_BUFFER_SECONDS = 300;
describe("live patched prompt-cache TTL", () => {
  test("설치본 prompt-cache-ttl.js 에 GPT-5.6 30분 계약이 살아 있다", () => {
    const stacks = stackByFile(collectPatchLayers(spec, repoRoot));
    const stack = stacks.get(TTL_REL);
    expect(stack).toBeDefined();
    const installedPath = join(spec.resolveRoot(), TTL_REL);
    expect(existsSync(installedPath)).toBe(true);
    const installed = readFileSync(installedPath, "utf8");
    const located = locateInStack(installed, stack!);
    expect(located).not.toBeNull();
    expect(located!.applied).toBe(stack!.length);
    expect(installed).toContain("PROMPT_CACHE_TTL_GPT56_SECONDS = 1800");
  });

  test("catalog GPT-5.6+ Codex/Responses 는 1800초 TTL 이다", () => {
    const responses = Object.entries(OPENAI_MODELS)
      .filter(([id]) => id.startsWith("gpt-5.6-"))
      .map(([, model]) => model);
    const codex = Object.entries(OPENAI_CODEX_MODELS)
      .filter(([id]) => id.startsWith("gpt-5.6-"))
      .map(([, model]) => model);
    expect(responses).toHaveLength(6);
    expect(codex).toHaveLength(6);
    for (const model of responses) {
      expect(model.api).toBe("openai-responses");
      expect(model.provider).toBe("openai");
    }
    for (const model of codex) {
      expect(model.api).toBe("openai-codex-responses");
      expect(model.provider).toBe("openai-codex");
    }
    for (const model of [...responses, ...codex]) {
      expect(resolvePromptCacheTtlSeconds(model)).toBe(PROMPT_CACHE_TTL_GPT56_SECONDS);
      expect(resolvePromptCacheTtlSeconds(model)).toBe(1800);
    }
    for (const id of ["gpt-5.7-preview", "gpt-6"]) {
      expect(resolvePromptCacheTtlSeconds({ ...OPENAI_MODELS["gpt-5.6-sol"], id })).toBe(1800);
    }
  });

  test("catalog GPT-5.5 이전 Codex/Responses 는 300초를 유지한다", () => {
    const earlier = [
      OPENAI_MODELS["gpt-5.5"],
      OPENAI_MODELS["gpt-5.4"],
      OPENAI_MODELS["gpt-5.3-codex"],
      OPENAI_CODEX_MODELS["gpt-5.5"],
      OPENAI_CODEX_MODELS["gpt-5.4"],
      OPENAI_CODEX_MODELS["gpt-5.3-codex-spark"],
    ];
    for (const model of earlier) {
      expect(resolvePromptCacheTtlSeconds(model)).toBe(PROMPT_CACHE_TTL_SHORT_SECONDS);
      expect(resolvePromptCacheTtlSeconds(model)).toBe(300);
    }
  });

  test("retention none 은 GPT-5.6 에서도 예산을 끈다", () => {
    const model = { ...OPENAI_MODELS["gpt-5.6-sol"], cacheRetention: "none" as const };
    expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
  });

  test("direct Anthropic long-retention 은 기존 1시간 TTL 이다", () => {
    const claude = ANTHROPIC_MODELS["claude-opus-5"];
    expect(claude.api).toBe("anthropic-messages");
    expect(claude.provider).toBe("anthropic");
    expect(claude.baseUrl).toBe("https://api.anthropic.com");
    const longClaude = { ...claude, cacheRetention: "long" as const };
    const shortClaude = { ...claude, cacheRetention: "short" as const };
    expect(resolvePromptCacheTtlSeconds(longClaude)).toBe(PROMPT_CACHE_TTL_LONG_SECONDS);
    expect(resolvePromptCacheTtlSeconds(longClaude)).toBe(3600);
    expect(resolvePromptCacheTtlSeconds(claude, { PI_CACHE_RETENTION: "long" })).toBe(3600);
    expect(resolvePromptCacheTtlSeconds(shortClaude)).toBe(PROMPT_CACHE_TTL_SHORT_SECONDS);
  });

  test("Rubato 5분 safety margin 이면 safe-wait 가 1500 / 3300 이다", () => {
    const settings = { safetyBufferSeconds: RUBATO_SAFETY_BUFFER_SECONDS };
    expect(resolvePromptCacheSafeWaitSeconds(OPENAI_MODELS["gpt-5.6-sol"], settings, {})).toBe(1500);
    expect(resolvePromptCacheSafeWaitSeconds(OPENAI_CODEX_MODELS["gpt-5.6-sol"], settings, {})).toBe(1500);
    expect(resolvePromptCacheSafeWaitSeconds({ ...ANTHROPIC_MODELS["claude-opus-5"], cacheRetention: "long" }, settings, {})).toBe(3300);
    expect(resolvePromptCacheSafeWaitSeconds(ANTHROPIC_MODELS["claude-opus-5"], settings, { PI_CACHE_RETENTION: "long" })).toBe(3300);
    expect(resolvePromptCacheSafeWaitSeconds(OPENAI_MODELS["gpt-5.5"], settings, {})).toBeUndefined();
  });

  test("Azure GPT-5.6 은 검증 전까지 300초 계약을 유지한다", () => {
    const azure = {
      ...OPENAI_MODELS["gpt-5.6-sol"],
      api: "azure-openai-responses" as const,
      provider: "azure",
    };
    expect(resolvePromptCacheTtlSeconds(azure)).toBe(PROMPT_CACHE_TTL_SHORT_SECONDS);
    expect(resolvePromptCacheTtlSeconds(azure)).toBe(300);
  });
});
