import { describe, expect, it } from "vite-plus/test";

import { piUsageFormat } from "./usage.ts";

const assistant = (provider: string, model: string) =>
  JSON.stringify({
    type: "message",
    id: "3f25bbc6",
    timestamp: "2026-11-20T04:21:03.954Z",
    message: {
      role: "assistant",
      provider,
      model,
      usage: { input: 1200, output: 300, cacheRead: 50_000, cacheWrite: 2_000, reasoning: 0 },
    },
  });

const parse = (line: string) => piUsageFormat.parseLine(line, piUsageFormat.state!.initial());

describe("Rubato's sessions in the usage history", () => {
  it("counts a vendor's model under that vendor, by its own model name", () => {
    expect(parse(assistant("anthropic", "claude-opus-5-5")).map((r) => [r.provider, r.model])).toEqual([
      ["claude", "claude-opus-5-5"],
    ]);
    expect(parse(assistant("openai-codex", "gpt-6.2-sol"))[0]?.provider).toBe("codex");
    expect(parse(assistant("xai", "grok-4.7"))[0]?.provider).toBe("grok");
    expect(parse(assistant("google-antigravity", "gemini-4-argon"))[0]?.provider).toBe("antigravity");
  });

  it("keeps any other provider under Pi with its provider in the model name", () => {
    expect(parse(assistant("opengateway", "deepseek-v4.1")).map((r) => [r.provider, r.model])).toEqual([
      ["pi", "opengateway/deepseek-v4.1"],
    ]);
  });
});
