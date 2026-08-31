import { describe, expect, test } from "bun:test";
import { FooterComponent, paintRubatoFallback } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/footer.js";
import { GrokFooter } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/grok/footer.js";

const HOST = Symbol.for("rubato.pi.footer");

function mockSession() {
  return {
    state: {
      model: {
        id: "anthropic/claude-opus-5",
        provider: "anthropic",
        contextWindow: 500_000,
      },
    },
    model: { id: "anthropic/claude-opus-5", contextWindow: 500_000 },
    sessionManager: {
      getUsageTotals: () => ({ cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }),
      getCwd: () => "/Users/wy/Github-repos/rubato-lab",
      getBranch: () => [],
      getSessionName: () => "",
    },
    getContextUsage: () => ({ tokens: 2, contextWindow: 500_000, percent: 0.4 }),
    modelRuntime: { isUsingSubscription: () => true },
    isFastModeActive: () => false,
  };
}

const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map(),
  getAvailableProviderCount: () => 1,
};

function senpiCostLine(text: string) {
  return /\$0\.000|\(sub\)|\(auto\)/.test(text);
}

describe("built-in footer never paints the senpi cwd/cost line", () => {
  test("fallback line is Rubato-shaped", () => {
    const lines = paintRubatoFallback({
      session: mockSession(),
      footerData,
    }, 120);
    const text = lines.join("\n");
    expect(text).toContain("✦");
    expect(text).toContain("Speed —");
    expect(senpiCostLine(text)).toBe(false);
  });

  test("FooterComponent stays on Rubato when the host is missing", () => {
    const prev = globalThis[HOST];
    try {
      delete globalThis[HOST];
      const footer = new FooterComponent(mockSession(), footerData);
      const text = footer.render(120).join("\n");
      expect(text).toContain("✦");
      expect(senpiCostLine(text)).toBe(false);
    } finally {
      if (prev === undefined) delete globalThis[HOST];
      else globalThis[HOST] = prev;
    }
  });

  test("FooterComponent stays on Rubato when the host painter throws", () => {
    const prev = globalThis[HOST];
    try {
      globalThis[HOST] = {
        paint() {
          throw new Error("paint boom");
        },
      };
      const footer = new FooterComponent(mockSession(), footerData);
      const text = footer.render(120).join("\n");
      expect(text).toContain("✦");
      expect(senpiCostLine(text)).toBe(false);
    } finally {
      if (prev === undefined) delete globalThis[HOST];
      else globalThis[HOST] = prev;
    }
  });

  test("GrokFooter uses the same Rubato fallback", () => {
    const prev = globalThis[HOST];
    try {
      delete globalThis[HOST];
      const footer = new GrokFooter(mockSession(), footerData);
      const text = footer.render(120).join("\n");
      expect(text).toContain("✦");
      expect(senpiCostLine(text)).toBe(false);
      expect(text).not.toContain("/Users/wy/Github-repos/rubato-lab");
    } finally {
      if (prev === undefined) delete globalThis[HOST];
      else globalThis[HOST] = prev;
    }
  });
});
