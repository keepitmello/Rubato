// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const sent = vi.hoisted(() => ({ calls: [] as Array<{ text: string; itemId?: string }>, prompts: [] as unknown[], fail: null as string | null }));
const view = {
  id: "segno",
  title: "Segno",
  home: "/h",
  exists: true,
  status: {
    path: "memory/status.md",
    updatedAt: "2026-11-08T10:00:00.000Z",
    sections: [{ title: "대기", items: [{ id: "status-1", text: "카줌: 셀러 첫 다섯 곳 연락 방법 네 답 대기", refs: "11-07" }] }],
  },
  questions: {
    path: "memory/to-ask.md",
    updatedAt: null,
    items: [
      { id: "ask-1", text: "셀러 컨택은 메일로 할까 수찬 전화로 할까?", refs: null, proposal: false },
      { id: "ask-2", text: "벌써 답한 것", refs: null, proposal: false, sent: "2026-11-08T10:00:00.000Z" },
      { id: "ask-3", text: "[user 조각 제안] 아침 인사는 짧게", refs: null, proposal: true },
    ],
  },
  about: [
    { id: "user-1", file: "memory/user.md", kind: "user", updatedAt: "2026-10-21T00:00:00.000Z", text: "맡길 땐 끝까지 맡긴다.", refs: null },
    { id: "us-1", file: "memory/us.md", kind: "us", updatedAt: null, text: "일은 세뇨, 곁은 루.", refs: null },
  ],
  records: [{ date: "2026-11-08", daily: "memory/2026-11-08.md", diary: "diary/2026-11-08.md", headline: "정식판 배포 · 홈 2차" }],
  weekly: [{ week: "2026-W44", path: "memory/weekly/2026-W44.md", headline: "주간 정리" }],
  entities: [{ name: "수찬", path: "memory/entities/suchan.md", summary: null, aka: [], tags: [], updated: null }],
  dream: null,
};

vi.mock("../../state/rubatoSegnoMemory", () => ({
  rubatoSegnoMemory: {
    memory: async () => view,
    search: async () => ({ results: [{ path: "memory/2026-11-08.md", line: 3, text: "검색된 줄" }], truncated: false }),
    file: async (_env: unknown, path: string) => ({ path, content: `# ${path}`, truncated: false, updatedAt: null }),
  },
  answerText: (question: string, answer: string) => `> ${question}\n\n${answer}`,
  changeRequestText: (line: string, request: string) => `> ${line}\n\n${request}`,
  useCompanionSender: () => ({
    ready: true,
    title: "Segno",
    threadId: "segno-thread",
    send: async (text: string, itemId?: string) => {
      if (sent.fail) throw new Error(sent.fail);
      sent.calls.push({ text, ...(itemId ? { itemId } : {}) });
    },
  }),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setPrompt: (ref: unknown, text: string) => sent.prompts.push({ ref, text }) }) },
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p data-testid="markdown">{text}</p> }));

const { RubatoSegnoPanel, openQuestionCount } = await import("./RubatoSegnoPanel");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // @ts-expect-error React's act environment flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sent.calls = [];
  sent.prompts = [];
  sent.fail = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount() {
  await act(async () =>
    root.render(<RubatoSegnoPanel environmentId={"env" as never} companionId="segno" companionTitle="Segno" threadId="segno-thread" onClose={() => {}} />),
  );
  await act(async () => {});
}
const tab = async (id: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-rubato-segno-panel-tab="${id}"]`)!.click());
};
const click = async (element: Element | null) => {
  await act(async () => (element as HTMLElement).click());
};
const type = async (element: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) ?? null;

it("has the four tabs, counts the open questions, and opens on the status board", async () => {
  await mount();
  expect([...host.querySelectorAll("[data-rubato-segno-panel-tab]")].map((item) => item.textContent)).toEqual([
    "Status board",
    "Questions1",
    "Memory",
    "Records",
  ]);
  expect(openQuestionCount(view as never)).toBe(1);
  expect(host.querySelector("[data-rubato-segno-status]")!.textContent).toContain("카줌: 셀러 첫 다섯 곳 연락 방법 네 답 대기");
});

it("answers a question into the conversation and marks it sent; a failed send says why and keeps the answer", async () => {
  await mount();
  await tab("questions");
  const first = host.querySelector('[data-rubato-segno-question="ask-1"]')!;
  expect(host.querySelector("[data-rubato-segno-questions]")!.firstElementChild).toBe(first);
  expect(host.querySelector('[data-rubato-segno-question="ask-3"]')!.textContent).toContain("Suggestion");
  await click(first.querySelector("button"));
  sent.fail = "Segno is not in the app yet.";
  await type(first.querySelector("textarea")!, "수찬 전화 먼저");
  await click(button("Send"));
  expect(first.textContent).toContain("Segno is not in the app yet.");
  expect(first.querySelector("textarea")!.value).toBe("수찬 전화 먼저");
  sent.fail = null;
  await click(button("Send"));
  expect(sent.calls).toEqual([{ text: "> 셀러 컨택은 메일로 할까 수찬 전화로 할까?\n\n수찬 전화 먼저", itemId: "ask-1" }]);
  expect(first.hasAttribute("data-sent")).toBe(true);
  expect(first.textContent).toContain("Sent");
});

it("puts a memory line in the composer as a change request instead of writing it", async () => {
  await mount();
  await tab("memory");
  const rows = [...host.querySelectorAll("[data-rubato-segno-memory] button")];
  expect(rows[0]!.textContent).toContain("About you");
  expect(rows[1]!.textContent).toContain("Between us");
  await click(rows[0]!);
  expect(sent.prompts).toEqual([{ ref: expect.objectContaining({ threadId: "segno-thread" }), text: "> 맡길 땐 끝까지 맡긴다.\n\n" }]);
  expect(sent.calls).toEqual([]);
});

it("searches the memory and reads a dated record", async () => {
  vi.useFakeTimers();
  await mount();
  await tab("memory");
  await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "검색");
  await act(async () => vi.advanceTimersByTime(300));
  vi.useRealTimers();
  await act(async () => {});
  expect(host.querySelector("[data-rubato-segno-memory]")!.textContent).toContain("검색된 줄");
  await tab("records");
  expect(host.querySelector("[data-rubato-segno-records]")!.textContent).toContain("정식판 배포 · 홈 2차");
  expect(host.querySelector("[data-rubato-segno-records]")!.textContent).toContain("수찬");
  await click(button("Diary"));
  await act(async () => {});
  expect(host.querySelector('[data-rubato-segno-record="diary/2026-11-08.md"] [data-testid="markdown"]')!.textContent).toBe("# diary/2026-11-08.md");
});
