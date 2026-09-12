import { Container } from "@earendil-works/pi-tui";

export const DEFAULT_TAIL_BUDGET = 60;
export const DEFAULT_WARM_CHUNK_SIZE = 100;
const PENDING_FIRST_PAINT = -1;

export class ProgressiveTranscriptContainer extends Container {
  constructor(options = {}) {
    super();
    this.hydratedFrom = PENDING_FIRST_PAINT;
    this.hydrationScheduled = false;
    this.hydrationGeneration = 0;
    this.hydrationHalted = false;
    this.lastRenderWidth = undefined;
    this.cachedWidth = undefined;
    this.childLineCache = new Map();
    this.cacheableBefore = 0;
    this.tailBudget = options.tailBudget ?? DEFAULT_TAIL_BUDGET;
    this.warmChunkSize = options.warmChunkSize ?? DEFAULT_WARM_CHUNK_SIZE;
    this.requestRender = options.requestRender ?? (() => {});
  }

  get isFullyHydrated() {
    return this.hydratedFrom === 0 && !this.hydrationScheduled;
  }

  render(width) {
    this.lastRenderWidth = width;
    if (this.cachedWidth !== width) {
      this.childLineCache.clear();
      this.cachedWidth = width;
    }
    const total = this.children.length;
    if (this.hydratedFrom === 0 || total === 0) {
      this.hydratedFrom = 0;
      return this.renderRange(0, total, width);
    }
    const firstVisible = Math.max(0, total - this.tailBudget);
    if (firstVisible === 0) {
      this.hydratedFrom = 0;
      return this.renderRange(0, total, width);
    }
    this.hydratedFrom = this.hydratedFrom === PENDING_FIRST_PAINT
      ? firstVisible
      : Math.min(this.hydratedFrom, firstVisible);
    this.scheduleHydration();
    return this.renderRange(this.hydratedFrom, total, width);
  }

  addChild(component) {
    super.addChild(component);
    this.childLineCache.delete(component);
  }

  markSettled() {
    this.cacheableBefore = this.children.length;
  }

  removeChild(component) {
    this.childLineCache.delete(component);
    const index = this.children.indexOf(component);
    if (index >= 0 && index < this.cacheableBefore) this.cacheableBefore -= 1;
    super.removeChild(component);
  }

  clear() {
    this.cancelHydration();
    this.hydratedFrom = PENDING_FIRST_PAINT;
    this.cacheableBefore = 0;
    this.childLineCache.clear();
    super.clear();
  }

  invalidate() {
    this.childLineCache.clear();
    super.invalidate();
  }

  renderRange(from, to, width) {
    const lines = [];
    const mouseChildren = [];
    for (let index = from; index < to; index++) {
      const child = this.children[index];
      if (child === undefined) continue;
      const cacheable = index < this.cacheableBefore;
      let childLines = cacheable ? this.childLineCache.get(child) : undefined;
      if (childLines === undefined) {
        try {
          childLines = child.render(width);
        } catch {
          const componentName = child.constructor.name || "AnonymousComponent";
          childLines = [`[render error: ${componentName}]`];
        }
        if (cacheable) this.childLineCache.set(child, childLines);
      }
      mouseChildren.push({ component: child, height: childLines.length });
      for (const line of childLines) lines.push(line);
    }
    this.mouseLayout = { width, children: mouseChildren };
    return lines;
  }

  scheduleHydration() {
    if (this.hydrationScheduled || this.hydrationHalted) return;
    this.hydrationScheduled = true;
    const generation = this.hydrationGeneration;
    setImmediate(() => {
      this.hydrationScheduled = false;
      this.warmNextChunk(generation);
    });
  }

  warmNextChunk(generation) {
    if (this.hydrationHalted || generation !== this.hydrationGeneration) return;
    if (this.hydratedFrom === 0) return;
    const chunkEnd = this.hydratedFrom;
    const chunkStart = Math.max(0, chunkEnd - this.warmChunkSize);
    const width = this.lastRenderWidth;
    if (width !== undefined) this.renderRange(chunkStart, chunkEnd, width);
    this.hydratedFrom = chunkStart;
    if (chunkStart === 0) {
      this.markSettled();
      this.requestRender();
      return;
    }
    this.scheduleHydration();
  }

  cancelHydration() {
    this.hydrationGeneration += 1;
    this.hydrationScheduled = false;
  }
}
