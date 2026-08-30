// pinned pi-ai 의 `lazyStream` 이 local-work 제어면을 위임하는지 본다.
//
// agent loop 는 자기가 들고 있는 stream 에 idle 기한을 다시 건다
// (`pi-agent-core/dist/agent-loop.js`: `stream?.hasPendingLocalWork?.()`).
// 그런데 lazy provider 가 돌려주는 것은 setup 뒤에 만들어지는 **안쪽** stream 이
// 아니라 바깥 `LazyAssistantMessageEventStream` 이다. 위임이 없으면 server-driven
// tool 이 idle 기한보다 오래 걸릴 때 살아 있는 요청이 끊긴다.
//
// 반례(pristine)를 상수 바이트나 상수 SHA 로 두지 않는다. 등록된 patch 스택을
// **역적용**해서 얻는다. 그래서 이 테스트는 patch 가 갱신돼도, 활성화 여부가 바뀌어도
// 따라온다 — 설치본이 곧 patched 라는 사실에 기대지 않는다.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, stackByFile } from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const SERIES_NAME = "@earendil-works%2Fpi-ai";
const LAZY_REL = "dist/api/lazy.js";
const STREAM_REL = "dist/utils/event-stream.js";

const spec = VENDOR_PATCHES.find((candidate) => candidate.seriesName === SERIES_NAME)!;
const piAiRoot = spec.resolveRoot();

function lazyStack() {
  return stackByFile(collectPatchLayers(spec, repoRoot)).get(LAZY_REL)!;
}

/**
 * lazy.js + event-stream.js 만 담은 fixture. 전체 의존성 트리를 복사하지 않는다
 * (설치본은 수백 MB고, 이 두 파일은 합쳐 수십 KB다).
 *
 * `variant: "installed"` 는 설치본 바이트 그대로 — 즉 등록된 patch 가 적용된 상태다.
 * `variant: "pristine"` 은 그 스택을 역적용해 얻은 patch 이전 상태다.
 */
function fixture(variant: "installed" | "pristine"): string {
  const root = mkdtempSync(join(tmpdir(), `rubato-pi-ai-${variant}-`));
  for (const rel of [LAZY_REL, STREAM_REL]) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    cpSync(join(piAiRoot, rel), join(root, rel));
  }
  if (variant === "pristine") {
    const installed = readFileSync(join(piAiRoot, LAZY_REL), "utf8");
    const located = locateInStack(installed, lazyStack());
    expect(located).not.toBeNull();
    writeFileSync(join(root, LAZY_REL), located!.pristine);
  }
  return root;
}

async function loadLazy(root: string) {
  return await import(join(root, LAZY_REL));
}

const model = { provider: "cursor", id: "composer-1", api: "cursor-agent" };

/**
 * server-driven tool 을 실행하는 동안 event 를 내지 않는 provider stream.
 * 언제 끝날지 모르는 일이므로 sleep 이 아니라 명시적으로 푸는 promise 로 잡는다.
 */
async function innerWithTrackedWork(root: string) {
  const { AssistantMessageEventStream } = await import(join(root, STREAM_REL));
  const inner = new AssistantMessageEventStream();
  const { promise, resolve } = Promise.withResolvers<string>();
  const tracked = inner.trackLocalWork(promise);
  return { inner, resolve, tracked };
}

describe("pi-ai lazyStream local-work delegation", () => {
  test("설치본은 등록된 스택이 적용된 상태다", () => {
    const stack = lazyStack();
    const installed = readFileSync(join(piAiRoot, LAZY_REL), "utf8");
    expect(locateInStack(installed, stack)?.applied).toBe(stack.length);
  });

  test("반례: patch 이전 바이트는 안쪽의 local work 를 보지 못한다 — 이것이 고치는 결함이다", async () => {
    const root = fixture("pristine");
    try {
      const { lazyStream } = await loadLazy(root);
      const { inner, resolve } = await innerWithTrackedWork(root);
      const outer = lazyStream(model, async () => inner);
      // setup 이 풀릴 틈을 준다. 그래도 바깥은 여전히 모른다.
      await Promise.resolve();
      await Promise.resolve();
      expect(inner.hasPendingLocalWork()).toBe(true);
      expect(outer.hasPendingLocalWork()).toBe(false);
      resolve("done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("설치본 바이트에서는 도구가 도는 동안 바깥 stream 도 pending 이다", async () => {
    const root = fixture("installed");
    try {
      const { lazyStream } = await loadLazy(root);
      const { inner, resolve, tracked } = await innerWithTrackedWork(root);
      const outer = lazyStream(model, async () => inner);
      await Promise.resolve();
      await Promise.resolve();

      expect(outer.hasPendingLocalWork()).toBe(true);

      // idle 기한이 이미 지난 상황을 만든다(0ms). agent loop 는 이 시점에
      // hasPendingLocalWork() 를 보고 기한을 다시 걸어야 하고, 끊지 않아야 한다.
      let wouldTearDown = false;
      for (let tick = 0; tick < 3; tick += 1) {
        await new Promise((next) => setTimeout(next, 0));
        if (!outer.hasPendingLocalWork()) wouldTearDown = true;
      }
      expect(wouldTearDown).toBe(false);

      resolve("tool output");
      expect(await tracked).toBe("tool output");
      expect(outer.hasPendingLocalWork()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("event 전달과 result() 는 그대로다", async () => {
    const root = fixture("installed");
    try {
      const { lazyStream } = await loadLazy(root);
      const { AssistantMessageEventStream } = await import(join(root, STREAM_REL));
      const inner = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [], stopReason: "stop" };
      const outer = lazyStream(model, async () => inner);
      inner.push({ type: "start", partial: message });
      inner.push({ type: "done", reason: "stop", message });
      inner.end(message);
      const types: string[] = [];
      for await (const event of outer) types.push(event.type);
      expect(types).toEqual(["start", "done"]);
      expect(await outer.result()).toBe(message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
