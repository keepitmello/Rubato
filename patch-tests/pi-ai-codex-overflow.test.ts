// Codex/ChatGPT 창 초과는 공개 OpenAI API 문구와 다른 래퍼로 온다.
// 그걸 overflow 로 못 보면 같은 턴을 재시도하고 컴팩션은 영영 안 돈다.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === "@earendil-works%2Fpi-ai")!;
const overflowPath = join(spec.resolveRoot(), "dist", "utils", "overflow.js");
const { isContextOverflow } = await import(pathToFileURL(overflowPath).href);

function assistant(errorMessage: string, usage?: { input: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }) {
  return {
    role: "assistant" as const,
    stopReason: "error" as const,
    errorMessage,
    content: [],
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("Codex overflow detection", () => {
  test("ChatGPT 래퍼 문구를 overflow 로 본다", () => {
    expect(isContextOverflow(assistant("The conversation is too long. Please start a new chat."), 272_000)).toBe(true);
    expect(isContextOverflow(assistant("Please try a shorter message."), 272_000)).toBe(true);
    expect(isContextOverflow(assistant("The requested context length is too large for this model."), 272_000)).toBe(true);
  });

  test("문구가 달라도 창을 채운 사용량이 있으면 overflow 다", () => {
    expect(
      isContextOverflow(
        assistant("Something went wrong processing your request.", {
          input: 2000,
          cacheRead: 270_000,
          totalTokens: 272_400,
        }),
        272_000,
      ),
    ).toBe(true);
  });

  test("같은 문구라도 창을 채우지 않은 오류는 overflow 가 아니다", () => {
    expect(
      isContextOverflow(
        assistant("Something went wrong processing your request.", { input: 1200, output: 40 }),
        272_000,
      ),
    ).toBe(false);
  });

  test("rate limit 은 창이 가득해도 overflow 로 승격하지 않는다", () => {
    expect(
      isContextOverflow(
        assistant("Rate limit reached. Too many requests.", { input: 271_000, cacheRead: 0, totalTokens: 271_000 }),
        272_000,
      ),
    ).toBe(false);
  });

  test("기존 OpenAI 문구는 그대로 overflow 다", () => {
    expect(isContextOverflow(assistant("Your input exceeds the context window of this model"), 272_000)).toBe(true);
  });
});
