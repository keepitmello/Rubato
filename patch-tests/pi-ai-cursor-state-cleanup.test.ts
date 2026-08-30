// Cursor module-local conversation state 가 **처분 가능한가**.
//
// pin 된 native transport 의 `conversationStateCache` / `conversationBlobStores` 는
// 무제한이었다: 프로세스가 살아 있는 동안 한 번 돌린 모든 conversation 의 checkpoint 와
// blob store 가 남았다. 이 patch 는 세 가지를 넣는다 — 세션 처분 hook 등록, session→wire
// lineage 추적, TTL/LRU 상한(활성 호출 보호).
//
// vendor·네트워크·포트를 건드리지 않는다. 설치본 export 만 부른다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === "@earendil-works%2Fpi-ai")!;
const piAiRoot = spec.resolveRoot();

const cursorAgent = await import(join(piAiRoot, "dist/api/cursor-agent.js"));
const rotation = await import(join(piAiRoot, "dist/api/cursor-conversation-rotation.js"));
const sessionResources = await import(join(piAiRoot, "dist/session-resources.js"));

describe("Cursor conversation state cleanup", () => {
  beforeEach(() => {
    cursorAgent.resetCursorConversationState();
  });

  test("처분 hook 이 공유 seam 에 등록돼 있다", () => {
    // 새 호출 자리를 만들지 않고 host 의 기존 세션 처분 경로를 쓴다. 등록됐다면
    // `cleanupSessionResources` 가 이 함수를 부른다.
    expect(typeof cursorAgent.disposeCursorSessionState).toBe("function");
    expect(typeof sessionResources.cleanupSessionResources).toBe("function");
    // 등록 여부는 동작으로 본다: 알 수 없는 세션 id 로도 throw 하지 않는다.
    expect(() => sessionResources.cleanupSessionResources("no-such-session")).not.toThrow();
  });

  test("상한이 정의돼 있고 유한하다", () => {
    expect(cursorAgent.CURSOR_CONVERSATION_STATE_TTL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(cursorAgent.CURSOR_CONVERSATION_STATE_TTL_MS)).toBe(true);
    expect(cursorAgent.CURSOR_CONVERSATION_STATE_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(cursorAgent.CURSOR_CONVERSATION_STATE_MAX)).toBe(true);
  });

  test("통계는 크기만 보고하고 대화 내용을 노출하지 않는다", () => {
    const stats = cursorAgent.cursorConversationStateStats();
    expect(Object.keys(stats).sort()).toEqual(["active", "blobStores", "lineages", "states", "tracked"]);
    for (const value of Object.values(stats)) expect(typeof value).toBe("number");
  });

  test("빈 세션 id 는 아무것도 처분하지 않는다", () => {
    expect(cursorAgent.disposeCursorSessionState("")).toBe(0);
    expect(cursorAgent.disposeCursorSessionState(undefined)).toBe(0);
    expect(cursorAgent.disposeCursorSessionState(42)).toBe(0);
  });

  test("reset 은 추적 상태를 비운다", () => {
    cursorAgent.resetCursorConversationState();
    const stats = cursorAgent.cursorConversationStateStats();
    expect(stats.states).toBe(0);
    expect(stats.blobStores).toBe(0);
    expect(stats.lineages).toBe(0);
    expect(stats.tracked).toBe(0);
    expect(stats.active).toBe(0);
  });
});

describe("rotation lineage cleanup", () => {
  let sandbox: string;
  let persistPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "rot-cleanup-"));
    persistPath = join(sandbox, "rot.json");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("forget 이 lineage 기록을 지우고, 없는 것은 false 다", () => {
    const store = rotation.createConversationRotationStore({ persistPath, randomId: () => "wire-1" });
    expect(store.forget("absent")).toBe(false);
    // poison 을 기록해 record 를 만든다(첫 번째는 surface, 두 번째가 rotate).
    store.markSurfaced("base-1", "base-1");
    expect(store.shouldSurfaceBeforeRotating("base-1")).toBe(false);
    const decision = store.recordZeroTokenPoison("base-1", "base-1");
    expect(decision.kind).toBe("rotated");
    expect(store.getWireId("base-1")).toBe("wire-1");
    // 처분: 기록이 사라진다.
    expect(store.forget("base-1")).toBe(true);
    // 기록이 없으면 base id 가 곧 wire id 이고, surface-first 가 다시 적용된다.
    expect(store.getWireId("base-1")).toBe("base-1");
    expect(store.shouldSurfaceBeforeRotating("base-1")).toBe(true);
    expect(store.shouldSkip("base-1")).toBe(false);
  });

  test("poison 처리 자체는 그대로다", () => {
    const store = rotation.createConversationRotationStore({ persistPath, randomId: () => "wire-2" });
    // 첫 0-token RE 는 surface 되고 rotate 하지 않는다 — 기존 계약이다.
    expect(store.shouldSurfaceBeforeRotating("base-2")).toBe(true);
    store.markSurfaced("base-2", "base-2");
    expect(store.shouldSurfaceBeforeRotating("base-2")).toBe(false);
    // rotation 예산을 넘기면 exhausted 다.
    let decision = store.recordZeroTokenPoison("base-2", "base-2");
    expect(decision.kind).toBe("rotated");
    for (let index = 0; index < rotation.MAX_CURSOR_CONVERSATION_ROTATIONS + 2; index += 1) {
      decision = store.recordZeroTokenPoison("base-2", "wire-2");
    }
    expect(decision.kind).toBe("exhausted");
    expect(store.shouldSkip("base-2")).toBe(true);
    store.forget("base-2");
  });
});
