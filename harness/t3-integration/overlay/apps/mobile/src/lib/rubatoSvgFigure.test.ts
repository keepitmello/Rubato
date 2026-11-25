import type { XmlAST } from "react-native-svg";
import { describe, expect, it } from "vite-plus/test";

import { markdownForNativeParsing } from "./markdownDocument";
import { safeSvgTree, svgFenceTitles } from "./rubatoSvgFigure";

const svg = '<svg viewBox="0 0 120 60"><circle cx="30" cy="30" r="20" stroke="currentColor"/></svg>';

describe("svgFenceTitles", () => {
  it("reads each svg fence's title back from the reply, keyed by its code", () => {
    const markdown = [
      "앞말",
      "",
      '```svg title="형태 차이를 설명하기 위한 개략도"',
      svg,
      "```",
      "",
      "````svg",
      "<svg/>",
      "````",
      "",
      "~~~svg title='두 번째'",
      '<svg width="10" height="10"/>',
      "~~~",
    ].join("\n");
    const titles = svgFenceTitles(markdown);
    expect(titles.get(svg)).toBe("형태 차이를 설명하기 위한 개략도");
    expect(titles.get('<svg width="10" height="10"/>')).toBe("두 번째");
    expect(titles.has("<svg/>")).toBe(false);
  });
});

describe("safeSvgTree", () => {
  // The shape react-native-svg's parser hands its middleware: attributes already camel-cased.
  const node = (tag: string, props: Record<string, unknown> = {}, children: (XmlAST | string)[] = []) =>
    ({ tag, props, children, parent: null, Tag: () => null }) as unknown as XmlAST;

  it("drops what could fetch or open anything and keeps the drawing", () => {
    const tree = safeSvgTree(
      node("svg", { viewBox: "0 0 10 10", onPress: "x" }, [
        node("defs", {}, [node("linearGradient", { id: "g" })]),
        node("rect", { fill: "url(#g)" }),
        node("rect", { fill: "url(https://x.test/a)", stroke: "currentColor" }),
        node("use", { href: "#g" }),
        node("use", { xlinkHref: "https://x.test/b#g" }),
        node("image", { href: "https://x.test/c.png" }),
        node("a", { href: "https://x.test" }, [node("text", {}, ["link"])]),
        node("style", {}, ["*{}"]),
        node("foreignObject"),
        node("text", { style: { fill: "url(https://x.test/d)" } }, ["G Pro X"]),
      ]),
    );
    const markup = JSON.stringify(tree, (key, value) => (key === "parent" || key === "Tag" ? undefined : value));
    expect(tree.props).not.toHaveProperty("onPress");
    expect(tree.children.map((child) => (typeof child === "string" ? child : child.tag))).toEqual([
      "defs",
      "rect",
      "rect",
      "use",
      "use",
      "text",
    ]);
    expect(markup).toContain("url(#g)");
    expect(markup).toContain('"href":"#g"');
    expect(markup).toContain("currentColor");
    expect(markup).toContain("G Pro X");
    expect(markup).not.toContain("x.test");
  });
});

describe("toned cells", () => {
  it("puts the tone's dot before a toned cell's words on the phone", () => {
    const markdown =
      '| 항목 | 차이 |\n|---|---|\n| 무게 | <span data-tone="good">매우 큼</span> |\n| 휠 | <span data-tone="bad">소폭 퇴보</span> |';
    const parsed = markdownForNativeParsing(markdown);
    expect(parsed).toContain("🟢 매우 큼");
    expect(parsed).toContain("🔴 소폭 퇴보");
    expect(parsed).not.toContain("<span");
  });
});
