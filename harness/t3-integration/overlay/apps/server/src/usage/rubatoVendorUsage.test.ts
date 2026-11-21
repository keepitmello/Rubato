import { describe, expect, it } from "vite-plus/test";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { rubatoVendorRecord, splitRubatoVendorSources } from "./rubatoVendorUsage.ts";

const record = (model: string, sessionId = "s1", provider: UsageRecord["provider"] = "pi") =>
  ({
    provider,
    timestampMs: 1,
    model,
    rateModel: model.slice(model.indexOf("/") + 1),
    sessionId,
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: model,
  }) as UsageRecord;

describe("rubatoVendorRecord", () => {
  it("counts a vendor's model under that vendor by its own name", () => {
    expect(rubatoVendorRecord(record("anthropic/claude-opus-5-5"))).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      rateModel: "claude-opus-5-5",
    });
    expect(rubatoVendorRecord(record("openai-codex/gpt-6.2-sol")).provider).toBe("codex");
    expect(rubatoVendorRecord(record("xai/grok-4.7")).provider).toBe("grok");
  });

  it("counts a model reached through another road under its maker, each lane by its own name", () => {
    const eco = rubatoVendorRecord(record("opengateway/deepseek/deepseek-v4.1-flash-eco"));
    const fast = rubatoVendorRecord(record("opengateway/deepseek/deepseek-v4.1-flash-ultrafast"));
    expect([eco.provider, eco.model]).toEqual(["deepseek", "deepseek-v4.1-flash-eco"]);
    expect([fast.provider, fast.model]).toEqual(["deepseek", "deepseek-v4.1-flash-ultrafast"]);
    expect(eco.rateModel).toBe("deepseek/deepseek-v4.1-flash-eco");
    expect(rubatoVendorRecord(record("google-vertex/gemini-4-argon"))).toMatchObject({
      provider: "gemini",
      model: "gemini-4-argon",
    });
    expect(rubatoVendorRecord(record("google-antigravity/gemini-4-argon")).provider).toBe("antigravity");
  });

  it("leaves unknown models, tool summaries and other readers alone", () => {
    expect(rubatoVendorRecord(record("nanogpt/glm-5.3")).provider).toBe("pi");
    expect(rubatoVendorRecord(record("Tools/summaries")).provider).toBe("pi");
    expect(rubatoVendorRecord(record("claude-opus-5-5", "s1", "claude")).model).toBe("claude-opus-5-5");
  });

  it("tells a record cached under a bare model name by its family", () => {
    expect(rubatoVendorRecord(record("claude-opus-5-5")).provider).toBe("claude");
    expect(rubatoVendorRecord(record("gemini-4-neon")).provider).toBe("antigravity");
    expect(rubatoVendorRecord(record("glm-5.3")).provider).toBe("pi");
  });
});

describe("splitRubatoVendorSources", () => {
  it("gives each vendor in a Pi directory its own source and leaves other directories whole", () => {
    const pi = { provider: "pi" as const, dir: "/home/.rubato-pi/agent/sessions" };
    const codex = { provider: "codex" as const, dir: "/home/.codex/sessions" };
    const split = splitRubatoVendorSources(
      [codex, pi],
      [
        [{ path: "/c.jsonl", records: [record("gpt-6", "c", "codex")], malformedRecords: 0 }],
        [
          {
            path: "/a.jsonl",
            records: [
              record("anthropic/claude-opus-5-5", "a"),
              record("nanogpt/glm-5.3", "a"),
              record("Tools/summaries", "a"),
            ],
            malformedRecords: 2,
          },
          { path: "/b.jsonl", records: [record("anthropic/claude-sonnet-5-5", "b")], malformedRecords: 0 },
        ],
      ],
    );
    expect(split.dirs.map((dir) => [dir.provider, dir.dir])).toEqual([
      ["codex", "/home/.codex/sessions"],
      ["pi", "/home/.rubato-pi/agent/sessions"],
      ["claude", "/home/.rubato-pi/agent/sessions"],
    ]);
    expect(split.files[1]!.map((file) => [file.path, file.records.length, file.malformedRecords])).toEqual([
      ["/a.jsonl", 1, 2],
      ["/b.jsonl", 0, 0],
    ]);
    // A file's tool results and summaries go to the vendor its model calls went to.
    expect(split.files[2]!.map((file) => [file.path, file.records.map((r) => r.model)])).toEqual([
      ["/a.jsonl", ["claude-opus-5-5", "Tools/summaries"]],
      ["/b.jsonl", ["claude-sonnet-5-5"]],
    ]);
  });
});
