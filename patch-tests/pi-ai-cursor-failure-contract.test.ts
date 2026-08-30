// 구조화된 Cursor 종료 계약이 **선언**으로도 존재하는가.
//
// JS 만 필드를 얹으면 `AssistantMessage.cursorFailure` 는 타입에 없는 필드가 된다.
// 소비자는 `as any` 로 읽게 되고, 그 순간 `kind` 오타나 없어진 kind 는 컴파일에서
// 잡히지 않는다 — 즉 "문자열 매칭을 없앴다"는 이득이 소비 지점에서 되돌아간다.
//
// 그래서 이 테스트는 두 가지만 본다: 선언이 실제 타입 검사에 쓰이는가, 그리고 런타임
// 판정이 그 선언과 같은 어휘를 내는가. vendor 나 네트워크는 건드리지 않는다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === "@earendil-works%2Fpi-ai")!;
const piAiRoot = spec.resolveRoot();

/** 설치본 선언을 실제로 불러 타입 검사한다. 통과/실패가 곧 계약이다. */
async function typecheck(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rubato-cursor-dts-"));
  try {
    const file = join(dir, "probe.ts");
    writeFileSync(file, source);
    const proc = Bun.spawnSync({
      cmd: ["bunx", "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--moduleResolution", "bundler", "--module", "esnext", file],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return `${proc.stdout.toString()}${proc.stderr.toString()}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TYPES = JSON.stringify(join(piAiRoot, "dist/types.d.ts").replace(/\.d\.ts$/, ".js"));
const CURSOR = JSON.stringify(join(piAiRoot, "dist/api/cursor-agent.d.ts").replace(/\.d\.ts$/, ".js"));

describe("Cursor 종료 계약이 선언 산출물에 있다", () => {
  test("AssistantMessage.cursorFailure 를 kind 와 함께 읽을 수 있다", async () => {
    const output = await typecheck(`
      import type { AssistantMessage, CursorFailureKind, CursorTerminalFailure } from ${TYPES};
      declare const message: AssistantMessage;
      // 선언이 없으면 여기서 "Property 'cursorFailure' does not exist" 가 난다.
      const failure: CursorTerminalFailure | undefined = message.cursorFailure;
      const kind: CursorFailureKind | undefined = failure?.kind;
      const eligible: boolean | undefined = failure?.fallbackEligible;
      void kind; void eligible;
    `);
    expect(output).toBe("");
  });

  test("없는 kind 는 컴파일에서 걸린다 — 이것이 문자열 매칭을 없앤 이유다", async () => {
    const output = await typecheck(`
      import type { CursorFailureKind } from ${TYPES};
      const kind: CursorFailureKind = "transprot";
      void kind;
    `);
    expect(output).toContain("transprot");
  });

  test("분류 함수들이 선언돼 있고 kind 를 돌려준다", async () => {
    const output = await typecheck(`
      import type { CursorFailureKind, CursorTerminalFailure } from ${TYPES};
      import { cursorFailureDescriptor, cursorFailureKindForConnectCode, cursorFailureKindOf, tagCursorFailure } from ${CURSOR};
      const tagged: Error = tagCursorFailure(new Error("x"), "transport");
      const a: CursorFailureKind = cursorFailureKindOf(tagged);
      const b: CursorFailureKind = cursorFailureKindForConnectCode("unauthenticated");
      const c: CursorFailureKind = cursorFailureKindForConnectCode(16);
      const d: CursorTerminalFailure = cursorFailureDescriptor(tagged, { aborted: true });
      void a; void b; void c; void d;
    `);
    expect(output).toBe("");
  });

  test("런타임 판정이 선언된 어휘와 정확히 같은 집합이다", async () => {
    const declared = await Bun.file(join(piAiRoot, "dist/types.d.ts")).text();
    const line = declared.split("\n").find((candidate) => candidate.includes("export type CursorFailureKind"))!;
    const fromDeclaration = [...line.matchAll(/"([a-z]+)"/g)].map((match) => match[1]).sort();
    const { CURSOR_FAILURE_KINDS } = await import(join(piAiRoot, "dist/api/cursor-agent.js"));
    expect([...CURSOR_FAILURE_KINDS].sort()).toEqual(fromDeclaration);
    // 그리고 harness 쪽 어휘도 같은 집합에서 나온다(no_* 사유는 canary 고유다).
    const { CURSOR_CANARY_FAILURES, CURSOR_FALLBACK_ELIGIBLE_KINDS } = await import(
      join(import.meta.dir, "../harness/rubato-pi/src/cursor-route.mjs")
    );
    for (const kind of CURSOR_FAILURE_KINDS) expect(CURSOR_CANARY_FAILURES).toContain(kind);
    for (const kind of CURSOR_FALLBACK_ELIGIBLE_KINDS) expect(fromDeclaration).toContain(kind);
  });
});
