import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { RubatoSvgFigure, rubatoSvgFigureMarkup } from "./RubatoSvgFigure";

const overlay =
  '<svg viewBox="0 0 320 160" xmlns="http://www.w3.org/2000/svg">' +
  '<defs><linearGradient id="fill"><stop offset="0" stop-color="#3b82f6"/></linearGradient></defs>' +
  '<ellipse cx="120" cy="80" rx="90" ry="50" fill="url(#fill)" fill-opacity="0.3" stroke="currentColor"/>' +
  '<text x="10" y="150" fill="currentColor">G Pro X</text></svg>';

describe("rubatoSvgFigureMarkup", () => {
  it("keeps the drawing at its drawn size and prefixes its ids", () => {
    const figure = rubatoSvgFigureMarkup(overlay)!;
    expect(figure.width).toBe(320);
    expect(figure.height).toBe(160);
    const id = /id="(rubato-svg-[^"]+-fill)"/.exec(figure.markup)?.[1];
    expect(id).toBeTruthy();
    expect(figure.markup).toContain(`url(#${id})`);
  });

  it("takes out what could run, navigate or fetch", () => {
    const figure = rubatoSvgFigureMarkup(
      '<svg width="40" height="20" onload="alert(1)"><script>alert(2)</script>' +
        '<style>body{display:none}</style><a href="https://x.test"><text>go</text></a>' +
        '<image href="https://x.test/a.png"/><rect fill="url(https://x.test/b)" width="5" height="5"/>' +
        '<use href="https://x.test/c#d"/><foreignObject><div>html</div></foreignObject></svg>',
    )!;
    expect(figure.markup).not.toMatch(/onload|script|<style|x\.test|foreignObject|<a\b/);
    expect(figure.markup).toContain('viewBox="0 0 40 20"');
  });

  it("leaves anything that is not one svg picture as code", () => {
    expect(rubatoSvgFigureMarkup("<div>not svg</div>")).toBeNull();
    expect(rubatoSvgFigureMarkup("<svg></svg>")).toBeNull();
    expect(rubatoSvgFigureMarkup("<svg width='10' height='10'/><svg width='10' height='10'/>")).toBeNull();
  });
});

describe("RubatoSvgFigure", () => {
  it("draws in the chat's text colour, never wider than the chat, with its caption", async () => {
    const onExpand = vi.fn();
    await using screen = await render(
      <div className="chat-markdown" style={{ width: 200, color: "rgb(10, 20, 30)" }}>
        <RubatoSvgFigure
          figure={rubatoSvgFigureMarkup(overlay)}
          title="형태 차이를 설명하기 위한 개략도"
          onExpand={onExpand}
        />
      </div>,
    );
    const svg = screen.container.querySelector("svg")!;
    expect(svg.getBoundingClientRect().width).toBeLessThanOrEqual(200);
    expect(svg.getBoundingClientRect().height).toBeCloseTo(svg.getBoundingClientRect().width / 2, 0);
    expect(getComputedStyle(svg).color).toBe("rgb(10, 20, 30)");
    await expect.element(screen.getByText("형태 차이를 설명하기 위한 개략도")).toBeVisible();
    (svg.parentElement as HTMLElement).click();
    expect(onExpand).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it("holds its place while the fence streams in", async () => {
    await using screen = await render(<RubatoSvgFigure figure={null} title={null} onExpand={() => {}} />);
    expect(screen.container.querySelector("svg")).toBeNull();
    expect(screen.container.querySelector("[data-rubato-svg-figure] .animate-pulse")).not.toBeNull();
  });
});
