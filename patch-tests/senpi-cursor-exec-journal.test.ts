// Cursor server-driven exec 의 **정착 계약**을 본다.
//
// `kCursorExecResolved` 는 현재 프로세스·현재 호출 안의 중복만 막는다. 재시작은 그
// 지식을 지우므로, 그 아래에 영속 journal 이 없으면 같은 `toolCallId` 가 두 번
// 실행된다 — 두 번째 `write`, 두 번째 `bash`. 이 patch 가 그 층이다:
// `{conversationLineageId, toolCallId}` key, `prepared → executing →
// completed | failed | unknown`, multi-process lock 과 temp write → fsync → rename.
//
// 재시작까지 포함한 exactly-once 는 약속하지 않는다. 그것을 **약속하지 않는다는 것**도
// 여기서 단정한다: `executing` 중에 죽으면 `unknown` 으로 정착하고 자동 재실행하지
// 않으며, 성공 turn 이 되지 않는다.
//
// 사망 지점을 신호 타이밍으로 맞추지 않는다. 설계가 이름 붙인 네 지점에서 자식이
// **스스로 SIGKILL** 한다 — 결정적이고 부모가 기다릴 것이 없다. 그 뒤 journal 을 다시
// 열어 정착 상태를 검사한다. `senpi-auth-storage-atomic-write.test.ts` 의 기법이다.
//
// 실제 profile 을 건드리지 않는다. 모든 경로는 mkdtemp 안이고, `:8788` 도 네트워크도
// 부르지 않는다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, stackByFile } from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const JOURNAL_REL = "dist/core/cursor-exec-journal.js";
const BRIDGE_REL = "dist/core/cursor-exec-bridge.js";
const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === "@code-yeongyu%2Fsenpi")!;
const senpiRoot = spec.resolveRoot();
const journalModulePath = join(senpiRoot, JOURNAL_REL);
const bridgeModulePath = join(senpiRoot, BRIDGE_REL);

const journalModule = await import(journalModulePath);
const bridgeModule = await import(bridgeModulePath);
const { createCursorExecJournal } = journalModule;

let sandbox: string;
let journalPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "rubato-exec-journal-"));
  journalPath = join(sandbox, "cursor-exec-journal.json");
  bridgeModule.resetCursorExecBridgeState();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  bridgeModule.resetCursorExecBridgeState();
});

/** journal 과 lock 을 뺀 나머지 — temp 잔재가 있으면 여기 잡힌다. */
function strayFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => name !== "cursor-exec-journal.json" && !name.startsWith("cursor-exec-journal.json.lock"),
  );
}

function openJournal(overrides: Record<string, unknown> = {}) {
  return createCursorExecJournal({ journalPath, ...overrides });
}

function readRaw(): { version: number; entries: Record<string, any> } {
  const raw = readFileSync(journalPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`journal is not complete JSON (${(error as Error).message}): ${raw.slice(0, 200)}`);
  }
}

/**
 * bridge 를 자식 프로세스에서 돌린다.
 *
 * 설치본 bridge 를 그대로 부르고, tool 만 대역으로 넣는다. 부작용은 sandbox 안의
 * 파일 append 로 표현하므로 "몇 번 실행됐는지" 가 바이트로 남는다. `KILL_AT` 이 설계가
 * 이름 붙인 네 지점 중 하나에서 자식을 즉사시킨다.
 */
function runBridgeChild(options: {
  killAt?: "before-exec" | "after-side-effect" | "after-completed" | "after-result";
  lineageId?: string;
  toolCallId?: string;
  allowFailure?: boolean;
  idempotencyKey?: string;
  calls?: number;
}) {
  const sideEffectLog = join(sandbox, "side-effects.log");
  const script = `
import { createCursorExecBridge } from ${JSON.stringify(`file://${bridgeModulePath}`)};
import { createCursorExecJournal } from ${JSON.stringify(`file://${journalModulePath}`)};
import { appendFileSync } from "node:fs";

const journalPath = ${JSON.stringify(journalPath)};
const sideEffectLog = ${JSON.stringify(sideEffectLog)};
const killAt = ${JSON.stringify(options.killAt ?? null)};
const lineageId = ${JSON.stringify(options.lineageId ?? "lineage-1")};
const toolCallId = ${JSON.stringify(options.toolCallId ?? "call-1")};
const idempotencyKey = ${JSON.stringify(options.idempotencyKey ?? null)};
const calls = ${options.calls ?? 1};

function die(point) {
  if (killAt === point) {
    // 시간으로 맞추지 않는다. 이 지점에서 스스로 즉사한다.
    process.kill(process.pid, "SIGKILL");
  }
}

const baseJournal = createCursorExecJournal({ journalPath });
// 설계가 이름 붙인 지점들은 journal write 의 전후다. 그래서 journal 자체를 감싸
// 그 경계에서 죽인다 — 구현을 바꾸는 것이 아니라 경계에 결함을 하나 심는 것이다.
const journal = {
  ...baseJournal,
  path: baseJournal.path,
  settleStale: () => baseJournal.settleStale(),
  settleAndListUnresolved: () => baseJournal.settleAndListUnresolved(),
  unreadableReason: () => baseJournal.unreadableReason(),
  resetUnreadable: (input) => baseJournal.resetUnreadable(input),
  read: (...a) => baseJournal.read(...a),
  list: () => baseJournal.list(),
  unresolved: () => baseJournal.unresolved(),
  prepare: (input) => baseJournal.prepare(input),
  markExecuting: (...a) => {
    const entry = baseJournal.markExecuting(...a);
    // 실행 직전: journal 은 executing 이고 부작용은 아직 없다.
    die("before-exec");
    return entry;
  },
  complete: (...a) => {
    const entry = baseJournal.complete(...a);
    // completed 기록 직후.
    die("after-completed");
    return entry;
  },
  markResultDelivered: (...a) => {
    const entry = baseJournal.markResultDelivered(...a);
    // tool result 저장 직후.
    die("after-result");
    return entry;
  },
};

const tool = {
  name: "sideEffect",
  parameters: { type: "object", properties: { note: { type: "string" } } },
  async execute(id, params) {
    // 진짜 부작용: 파일에 한 줄 붙인다. 두 번 실행되면 두 줄이 된다.
    appendFileSync(sideEffectLog, id + ":" + (params?.note ?? "") + "\\n");
    // 부작용 직후, journal 이 아직 executing 인 지점.
    die("after-side-effect");
    return { content: [{ type: "text", text: "did it" }] };
  },
};
if (idempotencyKey !== null) tool.idempotencyKeyFor = () => idempotencyKey;

const controller = new AbortController();
const events = [];
const toolResults = [];
const bridge = createCursorExecBridge({
  getTool: (name) => (name === "bash" ? tool : undefined),
  getConversationLineageId: () => lineageId,
  journal,
  emitEvent: async (event) => { events.push(event.type); },
  emitToolResult: async (event) => { toolResults.push(event.toolCallId); },
  getAbortSignal: () => controller.signal,
});

const results = [];
for (let i = 0; i < calls; i++) {
  results.push(bridge.piBash({ toolCallId, args: { command: "echo hi" } }));
}
const settled = await Promise.all(results);
console.log("RESULTS:" + JSON.stringify(settled.map((r) => ({
  isError: r.isError === true,
  text: (r.content ?? []).map((c) => c.text).join(""),
}))));
console.log("EVENTS:" + JSON.stringify(events));
console.log("TOOL_RESULTS:" + JSON.stringify(toolResults));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    env: { ...process.env, SENPI_CODING_AGENT_DIR: sandbox, RUBATO_PI_CODING_AGENT_DIR: sandbox },
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`child failed (status=${result.status}, signal=${result.signal}):\n${result.stderr}`);
  }
  const sideEffects = (() => {
    try {
      return readFileSync(sideEffectLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  const line = (tag: string) => {
    const found = result.stdout.split("\n").find((l) => l.startsWith(tag));
    return found === undefined ? undefined : JSON.parse(found.slice(tag.length));
  };
  return {
    ...result,
    sideEffects,
    results: line("RESULTS:") as { isError: boolean; text: string }[] | undefined,
    events: line("EVENTS:") as string[] | undefined,
    toolResults: line("TOOL_RESULTS:") as string[] | undefined,
  };
}

describe("cursor exec journal: 설치본과 형태", () => {
  test("설치본에 이 series 가 적용돼 있다", () => {
    const stacks = stackByFile(collectPatchLayers(spec, repoRoot));
    for (const rel of [JOURNAL_REL, BRIDGE_REL]) {
      const stack = stacks.get(rel)!;
      const installed = readFileSync(join(senpiRoot, rel), "utf8");
      expect(locateInStack(installed, stack)?.applied).toBe(stack.length);
    }
  });

  test("journal 은 profile 아래에 자리를 잡는다", () => {
    // 실제 profile 을 만들지 않는다. 경로 조립만 본다.
    expect(journalModule.cursorExecJournalPath("/tmp/some-profile")).toBe(
      "/tmp/some-profile/cursor-exec-journal.json",
    );
    expect(journalModule.CURSOR_EXEC_JOURNAL_FILE).toBe("cursor-exec-journal.json");
  });

  test("네 상태가 모두 정의돼 있다", () => {
    expect([
      journalModule.CURSOR_EXEC_PREPARED,
      journalModule.CURSOR_EXEC_EXECUTING,
      journalModule.CURSOR_EXEC_COMPLETED,
      journalModule.CURSOR_EXEC_FAILED,
      journalModule.CURSOR_EXEC_UNKNOWN,
    ]).toEqual(["prepared", "executing", "completed", "failed", "unknown"]);
  });

  test("쓰기는 mode 0600 이고 temp 잔재를 남기지 않는다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(strayFiles(sandbox)).toEqual([]);
  });
});

describe("cursor exec journal: 상태 기계", () => {
  test("prepared → executing → completed 를 지나면 replay 가 된다", () => {
    const journal = openJournal();
    expect(journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" }).decision).toBe("execute");
    expect(journal.read("L", "T").state).toBe("prepared");
    journal.markExecuting("L", "T");
    expect(journal.read("L", "T").state).toBe("executing");
    journal.complete("L", "T", { result: { content: [{ type: "text", text: "ok" }] } });
    const entry = journal.read("L", "T");
    expect(entry.state).toBe("completed");
    // 계약의 핵심: completed 와 영속 tool result 가 **함께** 있다.
    expect(entry.resultPersisted).toBe(true);
    expect(entry.sideEffect).toBe("happened");
  });

  test("completed 와 영속 result 가 함께 있으면 다시 실행하지 않는다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    journal.markExecuting("L", "T");
    journal.complete("L", "T", { result: { content: [{ type: "text", text: "stored" }] } });
    const again = journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(again.decision).toBe("replay");
    expect(again.entry.result).toEqual({ content: [{ type: "text", text: "stored" }] });
  });

  test("다른 lineage 의 같은 toolCallId 는 별개다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L1", toolCallId: "T", toolName: "bash" });
    journal.markExecuting("L1", "T");
    journal.complete("L1", "T", { result: {} });
    // key 는 {conversationLineageId, toolCallId} 다. lineage 가 다르면 남이다.
    expect(journal.prepare({ lineageId: "L2", toolCallId: "T", toolName: "bash" }).decision).toBe("execute");
  });

  test("살아 있는 프로세스가 쥔 entry 는 거절한다", () => {
    const journal = openJournal({ isOwnerAlive: () => true });
    journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    journal.markExecuting("L", "T");
    const second = journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(second.decision).toBe("refuse");
  });

  test("읽을 수 없는 journal 은 빈 것으로 다루지 않고 실행을 거절한다", () => {
    // 이 시험은 예전에는 반대 계약을 잠갔다: 깨진 파일을 없는 파일로 보고 execute 를 줬다.
    // 그건 중복 실행을 인가한다. 고의로 바꿨다.
    writeFileSync(journalPath, "{ this is not json", { mode: 0o600 });
    const damaged = readFileSync(journalPath, "utf8");
    const journal = openJournal();
    const decision = journal.prepare({ lineageId: "L", toolCallId: "T" });
    expect(decision.decision).toBe("refuse");
    expect(decision.reason).toMatch(/not valid JSON/);
    // 손상된 바이트를 빈 journal 로 덮어쓰지 않는다.
    expect(readFileSync(journalPath, "utf8")).toBe(damaged);
  });

  test("모르는 version 은 추측하지 않고 실행을 거절한다", () => {
    writeFileSync(journalPath, JSON.stringify({ version: 999, entries: { x: { state: "completed" } } }), {
      mode: 0o600,
    });
    const journal = openJournal();
    expect(journal.list()).toEqual([]);
    expect(journal.prepare({ lineageId: "L", toolCallId: "T" }).decision).toBe("refuse");
    expect(JSON.parse(readFileSync(journalPath, "utf8")).version).toBe(999);
  });

  test("lineage 를 잊으면 그 lineage 의 entry 만 사라진다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L1", toolCallId: "A" });
    journal.prepare({ lineageId: "L2", toolCallId: "B" });
    expect(journal.forgetLineage("L1")).toBe(1);
    expect(journal.list().map((e: any) => e.lineageId)).toEqual(["L2"]);
  });
});

describe("cursor exec journal: 손상된 파일은 빈 journal 이 아니다", () => {
  // 범위: profile-global refuse. 파일은 모든 lineage 의 신원 저장소다. 읽을 수 없으면
  // 어떤 lineage 가 깨끗한지 증명할 수 없고, 부분 거절은 다른 lineage 의 완료된 호출을
  // 재실행한다. 세션 전체가 일시적으로 못 쓰는 쪽이 안전하다.

  test("완료된 신원이 있는 파일이 깨져도 같은 {lineage, toolCallId} 는 거절된다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    journal.markExecuting("L", "T");
    journal.complete("L", "T", { result: { content: [{ type: "text", text: "stored" }] } });
    expect(journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" }).decision).toBe("replay");

    const before = readFileSync(journalPath);
    writeFileSync(journalPath, "{ this is not json", { mode: 0o600 });
    const damaged = readFileSync(journalPath, "utf8");

    const fresh = openJournal();
    const again = fresh.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(again.decision).toBe("refuse");
    expect(again.reason).toMatch(/not valid JSON/);
    // 다른 lineage 도 거절한다. 파일 전체를 못 읽으면 그 lineage 가 비었다고 말할 수 없다.
    expect(fresh.prepare({ lineageId: "OTHER", toolCallId: "U" }).decision).toBe("refuse");
    expect(readFileSync(journalPath, "utf8")).toBe(damaged);
    expect(before.equals(Buffer.from("{ this is not json"))).toBe(false);
  });

  test("없는 파일만 빈 journal 이다", () => {
    const journal = openJournal();
    expect(journal.prepare({ lineageId: "L", toolCallId: "T" }).decision).toBe("execute");
  });

  test("파싱 실패는 암묵적 reset 이 아니고, 명시 confirm 만 비운다", () => {
    writeFileSync(journalPath, "{ this is not json", { mode: 0o600 });
    const journal = openJournal();
    expect(journal.resetUnreadable().reset).toBe(false);
    expect(readFileSync(journalPath, "utf8")).toBe("{ this is not json");
    const refused = journal.resetUnreadable({ confirm: "please" });
    expect(refused.reset).toBe(false);

    const reset = journal.resetUnreadable({ confirm: "reset-unreadable-journal" });
    expect(reset.reset).toBe(true);
    expect(reset.quarantinedPath).toBeDefined();
    expect(readFileSync(reset.quarantinedPath!, "utf8")).toBe("{ this is not json");
    const state = readRaw();
    expect(state.entries).toEqual({});
    expect(journal.prepare({ lineageId: "L", toolCallId: "T" }).decision).toBe("execute");
  });

  test("읽을 수 있는 journal 은 reset 하지 않는다", () => {
    const journal = openJournal();
    journal.prepare({ lineageId: "L", toolCallId: "T" });
    const reset = journal.resetUnreadable({ confirm: "reset-unreadable-journal" });
    expect(reset.reset).toBe(false);
    expect(journal.read("L", "T").state).toBe("prepared");
  });
});

describe("cursor exec journal: 재시작 정착", () => {
  test("executing 이 남아 있으면 unknown 으로 정착하고 자동 재실행하지 않는다", () => {
    // 죽은 프로세스가 남긴 executing.
    const dead = openJournal({ pid: 999_001, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    dead.markExecuting("L", "T");
    expect(readRaw().entries["L\u0000T"].state).toBe("executing");

    // 새 프로세스가 journal 을 다시 연다.
    const fresh = openJournal({ pid: 999_002, isOwnerAlive: () => false });
    const settled = fresh.settleStale();
    expect(settled).toHaveLength(1);
    expect(settled[0].state).toBe("unknown");
    // 부작용 발생 여부는 알 수 없다. 그것을 그대로 말한다.
    expect(settled[0].sideEffect).toBe("unknown");
    expect(settled[0].settledFrom).toBe("executing");
    // 자동 재실행하지 않는다.
    const decision = fresh.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(decision.decision).toBe("refuse");
  });

  test("unknown 은 성공 turn 이 되지 않는다", () => {
    const dead = openJournal({ pid: 999_003, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_004, isOwnerAlive: () => false });
    fresh.settleStale();
    // 사용자와 agent loop 에 오류 상태로 노출된다.
    const unresolved = fresh.unresolved();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].state).toBe("unknown");
    expect(typeof unresolved[0].reason).toBe("string");
    // 그리고 그 뒤로도 replay 로 승격되지 않는다 — 영속 result 가 없다.
    expect(fresh.read("L", "T").resultPersisted).toBeUndefined();
  });

  test("prepared 만 남았으면 실행되지 않았다는 사실을 그대로 기록한다", () => {
    const dead = openJournal({ pid: 999_005, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T" });
    const fresh = openJournal({ pid: 999_006, isOwnerAlive: () => false });
    const settled = fresh.settleStale();
    // 부작용 직전의 durable write 가 아직 없었다. 추측이 아니라 사실이다.
    expect(settled[0].sideEffect).toBe("none");
    expect(settled[0].state).toBe("failed");
    // 그래도 자동 재실행은 하지 않는다 — 명시적 idempotency key 만 예외다.
    expect(fresh.prepare({ lineageId: "L", toolCallId: "T" }).decision).toBe("refuse");
  });

  test("살아 있는 프로세스의 mid-flight entry 는 정착시키지 않는다", () => {
    const live = openJournal({ pid: 999_007, isOwnerAlive: () => true });
    live.prepare({ lineageId: "L", toolCallId: "T" });
    live.markExecuting("L", "T");
    const other = openJournal({ pid: 999_008, isOwnerAlive: () => true });
    // 다른 프로세스가 지금 실행 중일 수 있다. 그것을 unknown 으로 만들면 거짓말이 된다.
    expect(other.settleStale()).toEqual([]);
    expect(other.read("L", "T").state).toBe("executing");
  });

  test("settleAndListUnresolved 는 도구 호출 없이 죽은 executing 을 보고한다", () => {
    const dead = openJournal({ pid: 999_021, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    dead.markExecuting("L", "T");
    expect(readRaw().entries["L\u0000T"].state).toBe("executing");

    const fresh = openJournal({ pid: 999_022, isOwnerAlive: () => false });
    // prepare 를 부르지 않는다. 시작 알림이 쓰는 경로다.
    const report = fresh.settleAndListUnresolved();
    expect(report.unreadable).toBe(false);
    expect(report.settled).toHaveLength(1);
    expect(report.settled[0].state).toBe("unknown");
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].toolName).toBe("bash");
    expect(readRaw().entries["L\u0000T"].state).toBe("unknown");
  });

  test("settleAndListUnresolved 는 살아 있는 owner 를 정착시키지 않는다", () => {
    const live = openJournal({ pid: 999_023, isOwnerAlive: () => true });
    live.prepare({ lineageId: "L", toolCallId: "T" });
    live.markExecuting("L", "T");
    const report = openJournal({ pid: 999_024, isOwnerAlive: () => true }).settleAndListUnresolved();
    expect(report.settled).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(readRaw().entries["L\u0000T"].state).toBe("executing");
  });
});

describe("cursor exec journal: idempotency", () => {
  test("멱등을 선언하지 않은 tool 은 재시도되지 않는다", () => {
    const dead = openJournal({ pid: 999_009, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_010, isOwnerAlive: () => false });
    fresh.settleStale();
    expect(fresh.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" }).decision).toBe("refuse");
  });

  test("선언된 key 만으로는 재시도되지 않는다 — tool 이 자기를 서열하는 것은 요구가 아니다", () => {
    const dead = openJournal({ pid: 999_011, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "mcp", idempotencyKey: "k-1" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_012, isOwnerAlive: () => false });
    fresh.settleStale();
    expect(fresh.read("L", "T").state).toBe("unknown");
    // 이것이 수통하면 평범한 재전달이 알 수 없는 부작용을 다시 일으킨다.
    const declaredOnly = fresh.prepare({ lineageId: "L", toolCallId: "T", toolName: "mcp", idempotencyKey: "k-1" });
    expect(declaredOnly.decision).toBe("refuse");
    expect(fresh.read("L", "T").state).toBe("unknown");
  });

  test("선언된 key 와 caller 의 명시 재시도 지시가 다 있으면 한 번 재시도한다", () => {
    const dead = openJournal({ pid: 999_015, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "mcp", idempotencyKey: "k-1" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_016, isOwnerAlive: () => false });
    fresh.settleStale();
    const retry = fresh.prepare({
      lineageId: "L",
      toolCallId: "T",
      toolName: "mcp",
      idempotencyKey: "k-1",
      retryAuthorization: { toolCallId: "T", idempotencyKey: "k-1", actor: "user" },
    });
    expect(retry.decision).toBe("execute");
    expect(retry.entry.attempt).toBe(2);
    expect(retry.entry.retriedFrom).toBe("unknown");
    expect(retry.entry.retryAuthorizedBy).toBe("user");
  });

  test("지시가 다른 toolCallId 를 가리키면 재시도되지 않는다", () => {
    const dead = openJournal({ pid: 999_017, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", toolName: "mcp", idempotencyKey: "k-1" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_018, isOwnerAlive: () => false });
    fresh.settleStale();
    const wrongTarget = fresh.prepare({
      lineageId: "L",
      toolCallId: "T",
      toolName: "mcp",
      idempotencyKey: "k-1",
      retryAuthorization: { toolCallId: "OTHER", actor: "user" },
    });
    expect(wrongTarget.decision).toBe("refuse");
  });

  test("key 가 다르면 재시도되지 않는다", () => {
    const dead = openJournal({ pid: 999_013, isOwnerAlive: () => false });
    dead.prepare({ lineageId: "L", toolCallId: "T", idempotencyKey: "k-1" });
    dead.markExecuting("L", "T");
    const fresh = openJournal({ pid: 999_014, isOwnerAlive: () => false });
    fresh.settleStale();
    // 다른 key 는 다른 요청이다. 같은 부작용을 다시 일으켜도 된다는 근거가 없다.
    expect(fresh.prepare({ lineageId: "L", toolCallId: "T", idempotencyKey: "k-2" }).decision).toBe("refuse");
    expect(fresh.prepare({ lineageId: "L", toolCallId: "T" }).decision).toBe("refuse");
  });
});

describe("cursor exec bridge: 한 프로세스 안에서 한 번만", () => {
  test("같은 toolCallId 를 동시에 열 번 불러도 한 번만 실행된다", () => {
    const child = runBridgeChild({ calls: 10 });
    // 부작용이 한 줄이다. 열 번 불렀지만 도구는 한 번 돌았다.
    expect(child.sideEffects).toEqual(["call-1:"]);
    // 열 개의 답이 모두 같은 결과다 — 하나는 성공, 나머지는 오류가 아니다.
    expect(child.results).toHaveLength(10);
    for (const result of child.results!) {
      expect(result.isError).toBe(false);
      expect(result.text).toBe("did it");
    }
    // tool_result 도 한 번만 나간다.
    expect(child.toolResults).toEqual(["call-1"]);
  });

  test("완료된 뒤 같은 toolCallId 를 다시 부르면 journal 이 replay 한다", () => {
    // 첫 프로세스가 정상 완료한다.
    const first = runBridgeChild({});
    expect(first.sideEffects).toEqual(["call-1:"]);
    // 새 프로세스가 같은 journal 로 같은 call 을 받는다.
    const second = runBridgeChild({});
    // 도구는 다시 돌지 않는다. 부작용 로그가 그대로 한 줄이다.
    expect(second.sideEffects).toEqual(["call-1:"]);
    // 그리고 저장된 결과로 답한다 — 오류가 아니다.
    expect(second.results![0]).toEqual({ isError: false, text: "did it" });
  });

  test("lineage id 가 없으면 실행하지 않고 오류로 답한다", () => {
    const script = `
import { createCursorExecBridge } from ${JSON.stringify(`file://${bridgeModulePath}`)};
import { appendFileSync } from "node:fs";
const controller = new AbortController();
const bridge = createCursorExecBridge({
  getTool: () => ({ name: "bash", parameters: { type: "object", properties: {} },
    async execute() { appendFileSync(${JSON.stringify(join(sandbox, "side-effects.log"))}, "ran\\n"); return { content: [] }; } }),
  getConversationLineageId: () => undefined,
  emitEvent: async () => {},
  getAbortSignal: () => controller.signal,
});
const r = await bridge.piBash({ toolCallId: "c", args: { command: "echo" } });
console.log("OUT:" + JSON.stringify({ isError: r.isError === true, text: (r.content ?? []).map((c) => c.text).join("") }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      env: { ...process.env, SENPI_CODING_AGENT_DIR: sandbox, RUBATO_PI_CODING_AGENT_DIR: sandbox },
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.split("\n").find((l) => l.startsWith("OUT:"))!.slice(4));
    // fail closed: durable key 가 없으면 journal 에 남길 수 없으므로 실행하지 않는다.
    expect(out.isError).toBe(true);
    expect(out.text).toContain("conversation lineage id");
    expect(strayFiles(sandbox)).toEqual([]);
  });
});

describe("cursor exec journal: 실제 크래시 정착", () => {
  test("실행 직전에 죽으면 executing 이 unknown 으로 정착한다", () => {
    const child = runBridgeChild({ killAt: "before-exec", allowFailure: true });
    expect(child.signal).toBe("SIGKILL");
    // 부작용은 일어나지 않았다.
    expect(child.sideEffects).toEqual([]);
    // 그러나 journal 은 executing 을 남겼다 — 이 프로세스는 그것을 알 수 없다.
    expect(readRaw().entries["lineage-1\u0000call-1"].state).toBe("executing");
    // 새 프로세스가 열면 unknown 으로 정착한다.
    const fresh = openJournal();
    const settled = fresh.settleStale();
    expect(settled.map((e: any) => [e.state, e.sideEffect])).toEqual([["unknown", "unknown"]]);
    // 자동 재실행하지 않는다.
    expect(fresh.prepare({ lineageId: "lineage-1", toolCallId: "call-1" }).decision).toBe("refuse");
  });

  test("부작용 직후에 죽으면 unknown 으로 정착하고 부작용은 두 번 일어나지 않는다", () => {
    const child = runBridgeChild({ killAt: "after-side-effect", allowFailure: true });
    expect(child.signal).toBe("SIGKILL");
    // 부작용은 정확히 한 번 일어났다.
    expect(child.sideEffects).toEqual(["call-1:"]);
    expect(readRaw().entries["lineage-1\u0000call-1"].state).toBe("executing");

    const fresh = openJournal();
    const settled = fresh.settleStale();
    expect(settled[0].state).toBe("unknown");
    expect(settled[0].sideEffect).toBe("unknown");
    // 다음 프로세스가 같은 call 을 받아도 도구는 다시 돌지 않는다.
    const second = runBridgeChild({});
    expect(second.sideEffects).toEqual(["call-1:"]);
    // 그리고 성공 turn 이 되지 않는다.
    expect(second.results![0].isError).toBe(true);
    expect(second.results![0].text).toContain("cannot be determined");
  });

  test("completed 기록 직후에 죽으면 결과가 남고 다시 실행하지 않는다", () => {
    const child = runBridgeChild({ killAt: "after-completed", allowFailure: true });
    expect(child.signal).toBe("SIGKILL");
    expect(child.sideEffects).toEqual(["call-1:"]);
    const entry = readRaw().entries["lineage-1\u0000call-1"];
    // completed 와 영속 result 는 한 번의 원자적 쓰기다. 둘 중 하나만 남는 창이 없다.
    expect(entry.state).toBe("completed");
    expect(entry.resultPersisted).toBe(true);
    // 그래서 정착시킬 것이 없다 — 이미 terminal 이다.
    const fresh = openJournal();
    expect(fresh.settleStale()).toEqual([]);
    // 다음 프로세스는 실행하지 않고 저장된 결과로 답한다.
    const second = runBridgeChild({});
    expect(second.sideEffects).toEqual(["call-1:"]);
    expect(second.results![0]).toEqual({ isError: false, text: "did it" });
  });

  test("tool result 저장 직후에 죽어도 다시 실행하지 않는다", () => {
    const child = runBridgeChild({ killAt: "after-result", allowFailure: true });
    expect(child.signal).toBe("SIGKILL");
    expect(child.sideEffects).toEqual(["call-1:"]);
    const entry = readRaw().entries["lineage-1\u0000call-1"];
    expect(entry.state).toBe("completed");
    expect(entry.resultPersisted).toBe(true);
    expect(entry.resultDelivered).toBe(true);
    const fresh = openJournal();
    expect(fresh.settleStale()).toEqual([]);
    const second = runBridgeChild({});
    expect(second.sideEffects).toEqual(["call-1:"]);
    expect(second.results![0]).toEqual({ isError: false, text: "did it" });
  });

  test("네 지점 모두에서 journal 파일은 언제나 완전한 JSON 이다", () => {
    for (const killAt of ["before-exec", "after-side-effect", "after-completed", "after-result"] as const) {
      rmSync(sandbox, { recursive: true, force: true });
      sandbox = mkdtempSync(join(tmpdir(), "rubato-exec-journal-"));
      journalPath = join(sandbox, "cursor-exec-journal.json");
      const child = runBridgeChild({ killAt, allowFailure: true });
      expect(child.signal).toBe("SIGKILL");
      // temp write → rename 이므로 찢어진 바이트가 대상에 들어가지 않는다.
      expect(() => readRaw()).not.toThrow();
      // 즉사한 경로라 temp 가 남을 수 있지만, 남더라도 점 접두사 temp 이므로
      // 읽는 쪽이 journal 로 오인하지 않는다.
      for (const name of strayFiles(sandbox)) {
        if (name === "side-effects.log") continue;
        expect(name.startsWith(".cursor-exec-journal.json.")).toBe(true);
        expect(name.endsWith(".tmp")).toBe(true);
      }
    }
  });
});

describe("cursor exec journal: 동시 writer", () => {
  test("여러 프로세스가 동시에 써도 journal 이 깨지지 않고 하나도 사라지지 않는다", () => {
    const writers = 8;
    const perWriter = 6;
    const script = `
import { createCursorExecJournal } from ${JSON.stringify(`file://${journalModulePath}`)};
const journal = createCursorExecJournal({ journalPath: ${JSON.stringify(journalPath)} });
// tag 는 env 로 받는다. -e 뒤의 위치 인자는 런타임마다 argv 자리가 달라서
// 조용히 undefined 가 되고, 그러면 여덟 writer 가 같은 key 를 써서 경합 자체가
// 사라진다 — 이 테스트가 아무것도 검사하지 않게 된다.
const tag = process.env.WRITER_TAG;
if (!tag) throw new Error("WRITER_TAG is required");
for (let i = 0; i < ${perWriter}; i++) {
  const toolCallId = tag + "-" + i;
  journal.prepare({ lineageId: "L", toolCallId, toolName: "bash" });
  journal.markExecuting("L", toolCallId);
  journal.complete("L", toolCallId, { result: { content: [{ type: "text", text: toolCallId }] } });
}
`;
    // 진짜 병렬이다: 각자 별개의 프로세스가 같은 파일을 두고 경합한다.
    const children = Array.from({ length: writers }, (_, index) =>
      Bun.spawn([process.execPath, "--input-type=module", "-e", script], {
        env: {
          ...process.env,
          SENPI_CODING_AGENT_DIR: sandbox,
          RUBATO_PI_CODING_AGENT_DIR: sandbox,
          WRITER_TAG: `w${index}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = children.map((child) => child.exited);
    return Promise.all(exits).then(async (codes) => {
      for (const [index, code] of codes.entries()) {
        if (code !== 0) {
          throw new Error(`writer ${index} failed (${code}): ${await new Response(children[index].stderr).text()}`);
        }
      }
      // 파일은 완전한 JSON 이고,
      const state = readRaw();
      // 모든 쓰기가 남아 있다 — lost update 가 없다.
      expect(Object.keys(state.entries)).toHaveLength(writers * perWriter);
      for (const entry of Object.values(state.entries)) {
        expect(entry.state).toBe("completed");
        expect(entry.resultPersisted).toBe(true);
      }
      expect(statSync(journalPath).mode & 0o777).toBe(0o600);
      // 정리되지 못한 temp 가 없다.
      expect(strayFiles(sandbox)).toEqual([]);
    });
  });
});

describe("cursor exec journal: 유계 보존이 중복 실행을 허용하지 않는다", () => {
  // 독립 리뷰가 잡은 결함: 무거운 진단 기록과 중복 판정 신원이 같은 상한을 쓰면,
  // 상한 밖으로 밀려난 toolCallId 가 재전달될 때 prepare 가 새 호출로 보고 execute 를 준다.
  // 그래서 둘을 갈랐다 — entries(진단)는 좁게, ledger(신원)는 넓게 보존한다.
  // 이 시험은 entries 를 자기 상한 밖으로 몰아낸 뒤에도 재전달이 거절되는지를 본다.

  test("rich record 가 상한에 밀려나도 같은 toolCallId 는 여전히 거절된다", () => {
    const journal = openJournal({ pid: 999_101, maxEntries: 4, isOwnerAlive: () => true });
    journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    journal.markExecuting("L", "T");
    journal.complete("L", "T", { ok: true });

    // 같은 lineage 로 상한을 훨씬 넘겨 T 의 진단 기록을 밀어낸다.
    for (let i = 0; i < 20; i += 1) {
      const id = `filler-${i}`;
      journal.prepare({ lineageId: "L", toolCallId: id, toolName: "bash" });
      journal.markExecuting("L", id);
      journal.complete("L", id, { ok: true });
    }

    // 진단 기록은 실제로 사라졌다 — 상한이 동작한다는 확인이다.
    expect(journal.read("L", "T")).toBeUndefined();

    // 그런데도 재전달은 실행되지 않는다. 신원이 ledger 에 남아 있기 때문이다.
    const again = journal.prepare({ lineageId: "L", toolCallId: "T", toolName: "bash" });
    expect(again.decision).not.toBe("execute");
  });

  test("ledger 는 살아 있는 lineage 의 신원을 반쪽으로 자르지 않는다", () => {
    // 가장 최근에 쓴 lineage 는 상한을 넘겨도 통째로 남는다. 반쪽만 남으면
    // 권위 있는 것처럼 보이면서 지워진 절반의 재실행을 허용한다.
    const journal = openJournal({ pid: 999_102, ledgerMaxIds: 3, isOwnerAlive: () => true });
    for (const id of ["a", "b", "c", "d", "e"]) {
      journal.prepare({ lineageId: "LIVE", toolCallId: id, toolName: "bash" });
      journal.markExecuting("LIVE", id);
      journal.complete("LIVE", id, { ok: true });
    }
    for (const id of ["a", "b", "c", "d", "e"]) {
      const again = journal.prepare({ lineageId: "LIVE", toolCallId: id, toolName: "bash" });
      expect(again.decision).not.toBe("execute");
    }
  });
});
