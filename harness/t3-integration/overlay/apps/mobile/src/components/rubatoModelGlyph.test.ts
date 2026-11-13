import { describe, expect, it } from "vite-plus/test";

import { resolveRubatoGlyph } from "./rubatoModelGlyph";

describe("resolveRubatoGlyph", () => {
  it("leaves every driver but rubato-pi to T3", () => {
    expect(resolveRubatoGlyph("codex", "anthropic/claude-opus-5-5")).toBeNull();
    expect(resolveRubatoGlyph("claudeAgent", "openai-codex/gpt-6.1-sol")).toBeNull();
    expect(resolveRubatoGlyph(undefined, "xai/grok-4.7")).toBeNull();
  });

  it("draws a vendor T3 knows with that vendor's driver glyph", () => {
    expect(resolveRubatoGlyph("rubato-pi", "openai-codex/gpt-6.1-sol")).toEqual({ kind: "driver", driver: "codex" });
    expect(resolveRubatoGlyph("rubato-pi", "anthropic/claude-opus-5-5-sub")).toEqual({ kind: "driver", driver: "claudeAgent" });
    expect(resolveRubatoGlyph("rubato-pi", "xai/grok-4.7")).toEqual({ kind: "driver", driver: "grok" });
    expect(resolveRubatoGlyph("rubato-pi", "cursor/claude-opus-5")).toEqual({ kind: "driver", driver: "cursor" });
  });

  it("keeps the model maker's mark through a gateway", () => {
    expect(resolveRubatoGlyph("rubato-pi", "opengateway/deepseek/deepseek-v4.1-flash-eco")).toEqual({ kind: "mark", mark: "deepseek" });
    expect(resolveRubatoGlyph("rubato-pi", "cursor/gemini-3.8-flash")).toEqual({ kind: "mark", mark: "gemini" });
    expect(resolveRubatoGlyph("rubato-pi", "google-vertex/gemini-4-argon")).toEqual({ kind: "mark", mark: "gemini" });
    expect(resolveRubatoGlyph("rubato-pi", "nanogpt/z-ai/glm-5.3-uncensored")).toEqual({ kind: "mark", mark: "zhipu" });
  });

  it("falls back to the Rubato mark, never to OpenAI", () => {
    expect(resolveRubatoGlyph("rubato-pi", "mystery/model-1")).toEqual({ kind: "mark", mark: "rubato" });
    expect(resolveRubatoGlyph("rubato-pi", null)).toEqual({ kind: "mark", mark: "rubato" });
  });
});
