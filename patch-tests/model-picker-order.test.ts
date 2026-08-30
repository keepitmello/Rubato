import { describe, expect, test } from "bun:test";
import { ModelSelectorComponent, sortModelItems } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/model-selector.js";
import { initTheme } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
import { stripAnsi } from "../node_modules/@code-yeongyu/senpi/dist/utils/ansi.js";

const item = (provider: string, id: string) => ({ provider, id });
const ids = (items: Array<{ provider: string; id: string }>) =>
  sortModelItems(items).map(({ provider, id }) => `${provider}/${id}`);

describe("Rubato model picker order", () => {
  test("keeps providers grouped in Rubato lane order", () => {
    expect(ids([
      item("cursor", "gpt-5.6-sol"),
      item("kiro", "gpt-5.6-sol"),
      item("anthropic", "claude-fable-5"),
      item("google-antigravity", "gemini-3.1-pro"),
      item("xai", "grok-4.6"),
      item("openai-codex", "gpt-5.6-sol"),
    ])).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-fable-5",
      "xai/grok-4.6",
      "google-antigravity/gemini-3.1-pro",
      "kiro/gpt-5.6-sol",
      "cursor/gpt-5.6-sol",
    ]);
  });

  test("uses the requested model rank inside each provider", () => {
    expect(ids([
      item("cursor", "composer-2.5"), item("cursor", "cursor-grok-4.6"),
      item("kiro", "claude-opus-5"), item("kiro", "gpt-5.6-sol"),
      item("anthropic", "claude-haiku-4-5"), item("anthropic", "claude-sonnet-5"),
      item("anthropic", "claude-opus-5"), item("anthropic", "claude-fable-5"),
      item("openai-codex", "gpt-5.6-luna"), item("openai-codex", "gpt-5.6-sol"),
      item("openai-codex", "gpt-5.6-terra"),
    ])).toEqual([
      "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna",
      "anthropic/claude-fable-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5",
      "kiro/gpt-5.6-sol", "kiro/claude-opus-5",
      "cursor/cursor-grok-4.6", "cursor/composer-2.5",
    ]);
  });

  test("keeps Codex bases together, then Fast variants", () => {
    expect(ids([
      item("openai-codex", "gpt-5.6-luna-fast"),
      item("openai-codex", "gpt-5.6-sol"),
      item("openai-codex", "gpt-daybreak-blue-latest-fast"),
      item("openai-codex", "gpt-5.6-terra-fast"),
      item("openai-codex", "gpt-5.6-luna"),
      item("openai-codex", "gpt-5.6-sol-fast"),
      item("openai-codex", "gpt-5.6-terra"),
      item("openai-codex", "gpt-daybreak-blue-latest"),
    ])).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol-fast",
      "openai-codex/gpt-5.6-terra-fast",
      "openai-codex/gpt-5.6-luna-fast",
      "openai-codex/gpt-daybreak-blue-latest",
      "openai-codex/gpt-daybreak-blue-latest-fast",
    ]);
  });

  test("puts unknown providers and models after ranked entries deterministically", () => {
    expect(ids([
      item("zzz", "b"), item("aaa", "z"),
      item("anthropic", "claude-new"), item("anthropic", "claude-fable-5"),
    ])).toEqual([
      "anthropic/claude-fable-5", "anthropic/claude-new", "aaa/z", "zzz/b",
    ]);
  });

  test("renders Daybreak aliases by product name instead of raw latest ids", () => {
    initTheme("dark", false);
    const models = [
      { provider: "openai-codex", id: "gpt-daybreak-blue-latest", name: "Daybreak Blue" },
      { provider: "openai-codex", id: "gpt-daybreak-blue-latest-fast", name: "Daybreak Blue Fast" },
    ].map((model) => ({
      ...model,
      api: "openai-codex-responses",
      baseUrl: "http://example.test",
      reasoning: true,
      input: ["text"],
      contextWindow: 272_000,
      maxTokens: 128_000,
    }));
    const runtime = {
      getAvailableSnapshot: () => models,
      getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getError: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
    };
    const component = new ModelSelectorComponent(
      { terminal: { rows: 40 }, requestRender() {} },
      models[0] as any,
      {} as any,
      runtime as any,
      [],
      () => {},
      () => {},
    );
    const rendered = stripAnsi(component.render(100).join("\n"));
    component.dispose();
    expect(rendered).toContain("Daybreak Blue [openai-codex]");
    expect(rendered).toContain("Daybreak Blue Fast [openai-codex]");
    expect(rendered).not.toContain("gpt-daybreak-blue-latest");
  });

  test("renders Cursor Grok as grok-4.6-fast, not the wire id", () => {
    initTheme("dark", false);
    const models = [
      { provider: "cursor", id: "cursor-grok-4.6", name: "Grok 4.6 Fast" },
      { provider: "xai", id: "grok-4.6", name: "Grok 4.6" },
    ].map((model) => ({
      ...model,
      api: "openai-completions",
      baseUrl: "http://example.test",
      reasoning: true,
      input: ["text"],
      contextWindow: 272_000,
      maxTokens: 128_000,
    }));
    const runtime = {
      getAvailableSnapshot: () => models,
      getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getError: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
    };
    const component = new ModelSelectorComponent(
      { terminal: { rows: 40 }, requestRender() {} },
      models[0] as any,
      {} as any,
      runtime as any,
      [],
      () => {},
      () => {},
    );
    const rendered = stripAnsi(component.render(100).join("\n"));
    component.dispose();
    expect(rendered).toContain("grok-4.6-fast [cursor]");
    expect(rendered).toContain("grok-4.6 [xai]");
    expect(rendered).not.toContain("cursor-grok-4.6");
  });
});
