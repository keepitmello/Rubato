// detached eval 완료 알림이 유저 턴(스티어링)으로 들어가던 결함.
//
// senpi-codemode 의 EvalNotifier 가 sendUserMessage 를 쓰면:
//   - 세션 jsonl 에 role:user 로 남고
//   - TUI 대기열이 Steering 으로 그린다
// sendMessage(custom, display:false, triggerTurn) 는 현재 어시스턴트 턴에 붙는다.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  VENDOR_PATCHES,
  collectPatchLayers,
  locateInStack,
  seriesDir,
  stackByFile,
} from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const SERIES_NAME = "@code-yeongyu%2Fsenpi-codemode";
const NOTIFIER_REL = "src/extension/eval-notifier.ts";
const INDEX_REL = "src/index.ts";

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === SERIES_NAME);

describe("@code-yeongyu/senpi-codemode eval notifier delivery", () => {
  test("canonical VENDOR_PATCHES 에 등록돼 있다", () => {
    expect(spec).toBeDefined();
    expect(spec!.patchName).toBe(`${SERIES_NAME}@${spec!.expectedVersion}.patch`);
    expect(existsSync(join(repoRoot, "patches", spec!.patchName))).toBe(true);
    expect(seriesDir(spec!, repoRoot)).toBe(join(repoRoot, "patches", SERIES_NAME, spec!.expectedVersion));
  });

  test("등록이 가리키는 자리가 senpi 가 품은 nested 사본이다", () => {
    const root = spec!.resolveRoot();
    const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
    expect(realpathSync(root)).toBe(
      realpathSync(join(senpiRoot, "node_modules/@code-yeongyu/senpi-codemode")),
    );
  });

  test("설치본 notifier 는 sendMessage 로 넣고 sendUserMessage 를 쓰지 않는다", () => {
    const root = spec!.resolveRoot();
    const notifier = readFileSync(join(root, NOTIFIER_REL), "utf8");
    const index = readFileSync(join(root, INDEX_REL), "utf8");
    expect(notifier).toContain("sendMessage");
    expect(notifier).toContain('customType: DETACHED_EVAL_MESSAGE_TYPE');
    expect(notifier).toContain("display: false");
    expect(notifier).toContain("triggerTurn: true");
    expect(notifier).not.toMatch(/sendUserMessage\s*\(/);
    expect(index).toContain("sendMessage: (message, notifyOptions) => pi.sendMessage(message, notifyOptions)");
    expect(index).not.toMatch(/pi\.sendUserMessage/);
  });

  test("설치본은 등록된 스택이 적용된 상태다", () => {
    const stacks = stackByFile(collectPatchLayers(spec!, repoRoot));
    const root = spec!.resolveRoot();
    for (const rel of [NOTIFIER_REL, INDEX_REL]) {
      const located = locateInStack(readFileSync(join(root, rel), "utf8"), stacks.get(rel)!);
      expect(located).not.toBeNull();
      expect(located?.applied).toBe(stacks.get(rel)!.length);
    }
  });

  test("반례: patch 이전 바이트는 sendUserMessage 로 유저 턴을 연다", () => {
    const stacks = stackByFile(collectPatchLayers(spec!, repoRoot));
    const root = spec!.resolveRoot();
    const located = locateInStack(readFileSync(join(root, NOTIFIER_REL), "utf8"), stacks.get(NOTIFIER_REL)!);
    expect(located).not.toBeNull();
    expect(located!.pristine).toContain("this.#deps.sendUserMessage(");
    expect(located!.pristine).not.toContain("DETACHED_EVAL_MESSAGE_TYPE");
  });
});

describe("EvalNotifier patched behavior", () => {
  test("#given a tui session #when a detached cell settles #then it injects a hidden custom message on the assistant turn", async () => {
    const root = spec!.resolveRoot();
    const { EvalNotifier, DETACHED_EVAL_MESSAGE_TYPE } = await import(join(root, NOTIFIER_REL));
    const calls: Array<{ message: unknown; options: unknown }> = [];
    const notifier = new EvalNotifier({
      sendMessage: (message: unknown, options: unknown) => {
        calls.push({ message, options });
      },
      getContext: () => ({ mode: "tui", model: { id: "x" } }),
      getMode: () => "wake",
    });
    notifier.notify([
      { cellId: "cell-1", content: "<system-reminder>Detached eval cell cell-1 (py) completed.\nok</system-reminder>" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toEqual({
      customType: DETACHED_EVAL_MESSAGE_TYPE,
      content: "<system-reminder>Detached eval cell cell-1 (py) completed.\nok</system-reminder>",
      display: false,
    });
    expect(calls[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });
});
