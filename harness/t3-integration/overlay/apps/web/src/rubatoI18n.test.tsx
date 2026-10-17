// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createPageTranslation, createUiTranslator, type UiDictionary } from "./rubatoI18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dictionary: UiDictionary = {
  exact: {
    Cancel: "취소하기",
    Retry: "다시 시도하기",
    "Copy message": "메시지 복사하기",
    "Search settings": "설정 검색",
    threads: "스레드",
    "Not installed": "설치되지 않음",
    "Thread: Pin to top": "스레드: 맨 위에 고정하기",
  },
  templates: [
    ["Started {0} {1} in background", "백그라운드에서 {1} {0}개를 시작했습니다"],
    ["Turn {0}", "{0}번째 턴"],
    ["Choose which <0/>login each GitHub host uses.", "각 GitHub 호스트가 사용할 <0/> 로그인을 선택합니다."],
    ["Run <0/> or add <1/>.", "<0/>를 실행하거나 <1/>를 추가하세요."],
    ["Reorder <0/> then <1/>.", "<1/> 다음 <0/>"],
    ["{0}s", "{0}초"],
    ["{0} for {1}", "{1}에 대한 {0}"],
    ["Update {0}", "{0} 업데이트하기"],
    ["Update Available: {0} {1}", "업데이트 가능: {0} {1}"],
    ["What should we build in {0}?", "{0}에서 무엇을 만들까요?"],
    ["Edit shortcut for {0}: {1}", "{0} 단축키 편집하기: {1}"],
  ],
};

const translator = createUiTranslator(dictionary);
let page: ReturnType<typeof createPageTranslation> | null = null;

function mount(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  page = createPageTranslation(root, translator);
  page.start();
  return root;
}

/** Mutation records arrive as a microtask, before the browser would paint. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  page?.stop();
  page = null;
  document.body.innerHTML = "";
});

describe("dictionary lookup", () => {
  it("finds exact entries, fills templates and translates values that are interface text", () => {
    expect(translator.lookup("Cancel")).toBe("취소하기");
    expect(translator.lookup("Started 3 threads in background")).toBe("백그라운드에서 스레드 3개를 시작했습니다");
    expect(translator.lookup("Something else")).toBeNull();
  });

  it("skips templates with too little literal text to mean anything", () => {
    expect(translator.lookup("45s")).toBeNull();
  });

  it("keeps a short template from swallowing a whole unrelated sentence", () => {
    expect(translator.lookup("Update Rubato")).toBe("Rubato 업데이트하기");
    expect(translator.lookup("Update Available: Codex v0.163.0")).toBe("업데이트 가능: Codex v0.163.0");
    expect(translator.lookup("Update Available everywhere and always")).toBeNull();
    expect(translator.lookup("Search for files")).toBe("files에 대한 Search");
    expect(translator.lookup("This provider version is outside the supported range for this T3 Code release.")).toBeNull();
    // A long value that is itself interface text is still a value.
    expect(translator.lookup("Edit shortcut for Thread: Pin to top: ⌘P")).toBe("스레드: 맨 위에 고정하기 단축키 편집하기: ⌘P");
  });
});

describe("page translation", () => {
  it("swaps interface text, keeping a node's own edge spaces", () => {
    const root = mount("<button> Cancel </button><span>My project</span>");
    expect(root.querySelector("button")!.textContent).toBe(" 취소하기 ");
    expect(root.querySelector("span")!.textContent).toBe("My project");
  });

  it("translates an icon and its label as the label", () => {
    const root = mount("<button><svg></svg>Cancel</button>");
    expect(root.querySelector("button")!.textContent).toBe("취소하기");
    expect(root.querySelector("svg")).not.toBeNull();
  });

  it("translates text that changes later, and leaves new text without an entry in English", async () => {
    const root = mount("<button>Cancel</button>");
    const text = root.querySelector("button")!.firstChild as Text;
    text.data = "Retry";
    await settle();
    expect(text.data).toBe("다시 시도하기");
    text.data = "Unknown label";
    await settle();
    expect(text.data).toBe("Unknown label");
  });

  it("joins split text nodes into one entry and follows a changing value", async () => {
    const root = mount("<span></span>");
    const span = root.querySelector("span")!;
    const label = document.createTextNode("Turn ");
    const count = document.createTextNode("3");
    span.append(label, count);
    await settle();
    expect(span.textContent).toBe("3번째 턴");
    count.data = "4";
    await settle();
    expect(span.textContent).toBe("4번째 턴");
  });

  it("places Korean around child elements that stay in place", () => {
    const root = mount("<p>Choose which <code>gh</code>login each GitHub host uses.</p>");
    const p = root.querySelector("p")!;
    expect(p.textContent).toBe("각 GitHub 호스트가 사용할 gh 로그인을 선택합니다.");
    expect(p.querySelector("code")!.textContent).toBe("gh");
  });

  it("handles text on both sides of several elements", () => {
    const root = mount("<p>Run <code>npx t3 serve</code> or add <code>--tailscale</code>.</p>");
    expect(root.querySelector("p")!.textContent).toBe("npx t3 serve를 실행하거나 --tailscale를 추가하세요.");
  });

  it("fills an element into a template value when only punctuation follows it", () => {
    const root = mount("<h1>What should we build in <button>rubato</button>?</h1>");
    expect(root.querySelector("h1")!.textContent).toBe("rubato에서 무엇을 만들까요?");
    expect(root.querySelector("button")!.textContent).toBe("rubato");
  });

  it("leaves an entry that would reorder elements in English", () => {
    const root = mount("<p>Reorder <b>a</b> then <b>b</b>.</p>");
    expect(root.querySelector("p")!.textContent).toBe("Reorder a then b.");
  });

  it("translates tooltips and placeholders, and follows their changes", async () => {
    const root = mount('<input placeholder="Search settings"><button title="Copy message" aria-label="Copy message"></button>');
    const input = root.querySelector("input")!;
    const button = root.querySelector("button")!;
    expect(input.getAttribute("placeholder")).toBe("설정 검색");
    expect(button.getAttribute("title")).toBe("메시지 복사하기");
    expect(button.getAttribute("aria-label")).toBe("메시지 복사하기");
    button.setAttribute("title", "Cancel");
    await settle();
    expect(button.getAttribute("title")).toBe("취소하기");
  });

  it("never touches messages, code, the composer or anything marked translate=no", async () => {
    const root = mount(
      [
        '<div class="chat-markdown"><p>Cancel</p></div>',
        "<pre>Cancel</pre>",
        '<div contenteditable="true">Cancel</div>',
        '<span translate="no">Cancel</span>',
        '<div data-user-message-collapsed="false"><div>Cancel</div></div>',
      ].join(""),
    );
    const late = document.createElement("p");
    late.textContent = "Cancel";
    root.querySelector(".chat-markdown")!.append(late);
    await settle();
    expect(root.textContent).toBe("Cancel".repeat(6));
  });

  it("puts the English back when stopped", () => {
    const root = mount('<button title="Copy message">Cancel</button><p>Choose which <code>gh</code>login each GitHub host uses.</p>');
    page!.stop();
    page = null;
    expect(root.querySelector("button")!.textContent).toBe("Cancel");
    expect(root.querySelector("button")!.getAttribute("title")).toBe("Copy message");
    expect(root.querySelector("p")!.textContent).toBe("Choose which ghlogin each GitHub host uses.");
  });
});

describe("with React rendering the page", () => {
  function Panel(props: { busy: boolean; turn: number; items: string[] }) {
    return (
      <div>
        <button type="button" title={props.busy ? "Cancel" : "Retry"}>
          {props.busy ? "Cancel" : "Retry"}
        </button>
        <span>Turn {props.turn}</span>
        <ul>
          {props.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          Choose which <code>gh</code>
          {props.busy ? "login each GitHub host uses." : "Not installed"}
        </p>
      </div>
    );
  }

  it("keeps up with re-renders, removals and reorders without React losing its nodes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    page = createPageTranslation(container, translator);
    page.start();
    const root = createRoot(container);

    await act(async () => root.render(<Panel busy turn={3} items={["Cancel", "Retry", "Plain"]} />));
    expect(container.querySelector("button")!.textContent).toBe("취소하기");
    expect(container.querySelector("button")!.title).toBe("취소하기");
    expect(container.querySelector("span")!.textContent).toBe("3번째 턴");
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["취소하기", "다시 시도하기", "Plain"]);
    expect(container.querySelector("p")!.textContent).toBe("각 GitHub 호스트가 사용할 gh 로그인을 선택합니다.");

    await act(async () => root.render(<Panel busy={false} turn={4} items={["Plain", "Cancel"]} />));
    expect(container.querySelector("button")!.textContent).toBe("다시 시도하기");
    expect(container.querySelector("button")!.title).toBe("다시 시도하기");
    expect(container.querySelector("span")!.textContent).toBe("4번째 턴");
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Plain", "취소하기"]);
    // No entry for this sentence: each piece falls back to its own entry.
    expect(container.querySelector("p")!.textContent).toBe("Choose which gh설치되지 않음");

    await act(async () => root.render(<Panel busy turn={4} items={[]} />));
    expect(container.querySelector("p")!.textContent).toBe("각 GitHub 호스트가 사용할 gh 로그인을 선택합니다.");

    page.stop();
    page = null;
    expect(container.querySelector("button")!.textContent).toBe("Cancel");
    expect(container.querySelector("span")!.textContent).toBe("Turn 4");
    await act(async () => root.render(<Panel busy={false} turn={5} items={["Retry"]} />));
    expect(container.querySelector("button")!.textContent).toBe("Retry");
    expect(container.querySelector("span")!.textContent).toBe("Turn 5");
    await act(async () => root.unmount());
  });
});
