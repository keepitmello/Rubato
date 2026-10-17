import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeAI, OpenAI } from "../Icons";
import { GeminiIcon } from "../GeminiIcon";
import { threadModelIcon } from "./rubatoThreadModelIcon";

const rubato = ProviderDriverKind.make("rubato-pi");

describe("threadModelIcon", () => {
  it("gives a Rubato thread the icon of its model's company", () => {
    expect(threadModelIcon(rubato, "anthropic/claude-opus-5-5")).toBe(ClaudeAI);
    expect(threadModelIcon(rubato, "openai-codex/gpt-5.5")).toBe(OpenAI);
    expect(threadModelIcon(rubato, "google-vertex/gemini-3-pro")).toBe(GeminiIcon);
  });

  it("returns null for an unknown model so the card keeps the instance icon", () => {
    expect(threadModelIcon(rubato, "mystery/model-1")).toBeNull();
    expect(threadModelIcon(rubato, "bare-slug")).toBeNull();
  });

  it("returns null while the thread's provider is not loaded yet", () => {
    expect(threadModelIcon(null, "anthropic/claude-opus-5-5")).toBeNull();
  });

  it("leaves other drivers on their own icon", () => {
    expect(threadModelIcon(ProviderDriverKind.make("codex"), "anthropic/claude-opus-5-5")).toBeNull();
  });
});
