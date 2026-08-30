import { afterEach, describe, expect, test } from "bun:test";
import { ProgressiveTranscriptContainer } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/progressive-transcript-container.js";

class CountingComponent {
  calls = 0;
  constructor(public lines: string[]) {}
  render() {
    this.calls += 1;
    return this.lines;
  }
  invalidate() {}
}

const containers: ProgressiveTranscriptContainer[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) container.dispose();
});

function fixture(count: number) {
  const container = new ProgressiveTranscriptContainer({
    tailBudget: count,
    warmChunkSize: count,
    requestRender() {},
  });
  containers.push(container);
  const children = Array.from({ length: count }, (_, index) => new CountingComponent([`row ${index}`]));
  for (const child of children) container.addChild(child as any);
  container.markSettled();
  return { container, children };
}

describe("progressive transcript settled-row cache", () => {
  test("repeated frames reuse old child lines", () => {
    const { container, children } = fixture(500);
    expect(container.render(120)).toHaveLength(500);
    for (let frame = 0; frame < 100; frame += 1) container.render(120);
    expect(children.reduce((sum, child) => sum + child.calls, 0)).toBe(500);
  });

  test("width and explicit invalidation rebuild the cache", () => {
    const { container, children } = fixture(3);
    container.render(120);
    container.render(100);
    expect(children.map((child) => child.calls)).toEqual([2, 2, 2]);
    container.invalidate();
    container.render(100);
    expect(children.map((child) => child.calls)).toEqual([3, 3, 3]);
  });

  test("new children render without invalidating settled history", () => {
    const { container, children } = fixture(2);
    container.render(120);
    const appended = new CountingComponent(["new"]);
    container.addChild(appended as any);
    expect(container.render(120)).toEqual(["row 0", "row 1", "new"]);
    expect(children.map((child) => child.calls)).toEqual([1, 1]);
    expect(appended.calls).toBe(1);
  });

  test("the current mutable tail rerenders until it is settled", () => {
    const { container, children } = fixture(1);
    container.render(120);
    const live = new CountingComponent(["partial"]);
    container.addChild(live as any);
    expect(container.render(120)).toEqual(["row 0", "partial"]);
    live.lines = ["complete"];
    expect(container.render(120)).toEqual(["row 0", "complete"]);
    expect(children[0].calls).toBe(1);
    expect(live.calls).toBe(2);
  });

  test("detaching a cached child releases it", () => {
    const { container, children } = fixture(2);
    container.render(120);
    container.detachChild(children[0] as any);
    expect(container.render(120)).toEqual(["row 1"]);
  });
});
