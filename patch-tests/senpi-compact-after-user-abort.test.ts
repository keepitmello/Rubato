// Codex 턴이 끝나지 않은 채 창을 넘기면, Escape 가 compact 를 취소하고
// agent_end 는 유저 abort 라서 자동 컴팩션까지 건너뛰었다. 그 다음 프롬프트가
// 와서야 pre_prompt compact 가 돌았다. 이 테스트는 그 두 구멍을 설치본에서 지킨다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
const source = readFileSync(join(senpiRoot, "dist", "core", "agent-session.js"), "utf8");

describe("compaction after a looping turn", () => {
  test("유저 abort 뒤에도 아직 필요한 compact 는 돌린다 (재시도는 하지 않는다)", () => {
    const marker = "User abort must not skip a still-required compact";
    expect(source).toContain(marker);
    const abortCompact = source.slice(source.indexOf(marker), source.indexOf("else if (!retryContinuationBlocked && !userAbortSuppressedQueuedContinuation)"));
    expect(abortCompact).toContain("await this._checkCompaction(msg, true, undefined, false)");
    expect(abortCompact).toContain("if (requiredAutoCompaction)");
    expect(abortCompact).not.toContain("retryAfterRequiredCompaction");
  });

  test("Escape 는 이미 돌아가는 요약만 취소하고, 대기 중인 /compact 는 남긴다", () => {
    expect(source).toContain("if (this._compactionLifecycle.state.status === \"running\")");
    const abortFn = source.slice(source.indexOf("async abort() {"), source.indexOf("async waitForIdle()"));
    expect(abortFn).toContain("abortCompaction()");
    // 무조건 abortCompaction() 하던 줄은 없어야 한다 — 그게 /compact 를 죽이던 줄이다.
    expect(abortFn).not.toMatch(/shouldEmitAbort[\s\S]*?this\.abortCompaction\(\);\s*await this\._abortActiveAgentAndRetry\("user"\)/);
  });

  test("/compact 는 턴 abort 를 무한히 기다리지 않는다", () => {
    expect(source).toContain("_waitForIdleWithTimeout");
    expect(source).toContain("_abortActiveAgentAndRetry(\"system\", 10_000)");
    expect(source).toContain("Turn did not stop after abort");
  });
});
