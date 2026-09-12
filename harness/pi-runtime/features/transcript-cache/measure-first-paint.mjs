import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.RUBATO_A2A3_EVIDENCE_DIR || join(here, "evidence");
mkdirSync(outDir, { recursive: true });
const tuiPackage = join(here, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui");
const work = join(outDir, "transcript-work");
mkdirSync(join(work, "node_modules/@earendil-works"), { recursive: true });
try { symlinkSync(tuiPackage, join(work, "node_modules/@earendil-works/pi-tui")); } catch (error) {
  if (error.code !== "EEXIST") throw error;
}
writeFileSync(join(work, "progressive-transcript-container.mjs"), readFileSync(join(here, "progressive-transcript-container.mjs")));
const { ProgressiveTranscriptContainer } = await import(pathToFileURL(join(work, "progressive-transcript-container.mjs")).href);
const { Container } = await import(pathToFileURL(join(tuiPackage, "dist/tui.js")).href);

function heavyChild(id) {
  return {
    render(width) {
      const lines = [];
      for (let i = 0; i < 20; i += 1) {
        lines.push(("md-" + id + "-" + i).padEnd(Math.max(8, width)));
      }
      return lines;
    },
  };
}

function fill(container, count) {
  for (let i = 0; i < count; i += 1) container.addChild(heavyChild(i));
}

const count = 180;
const eager = new Container();
fill(eager, count);
const t0 = performance.now();
eager.render(80);
const eagerMs = performance.now() - t0;

const progressive = new ProgressiveTranscriptContainer({ tailBudget: 60, warmChunkSize: 100, requestRender: () => {} });
fill(progressive, count);
const t1 = performance.now();
const first = progressive.render(80);
const progressiveMs = performance.now() - t1;

const report = [
  `children=${count}`,
  `eager first paint: ${eagerMs.toFixed(2)} ms (all ${count} children)`,
  `progressive first paint: ${progressiveMs.toFixed(2)} ms (tail ${60}, lines=${first.length})`,
  `speedup: ${(eagerMs / Math.max(progressiveMs, 0.001)).toFixed(1)}x`,
].join("\n") + "\n";
const path = join(outDir, "transcript-first-paint.txt");
writeFileSync(path, report);
console.log(JSON.stringify({ path, eagerMs, progressiveMs, firstLines: first.length }, null, 2));
