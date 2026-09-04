import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { senpiDir } from "../../src/engine-paths.mjs";
import { applyBootPerfTransforms } from "../../src/transforms/boot-perf.mjs";
import { injectInteractiveDeferDialogs } from "../../src/transforms/boot-interactive-defer.mjs";

const interactivePath = join(senpiDir, "dist", "modes", "interactive", "interactive-mode.js");

function applyNoThrow(url, source) {
  const warnings = [];
  const next = applyBootPerfTransforms(url, source, (text, transform) => {
    try {
      const out = transform(text);
      return typeof out === "string" ? out : text;
    } catch (error) {
      warnings.push(error.message);
      return text;
    }
  });
  return { next, warnings };
}

test("dialog and mermaid imports leave the InteractiveMode static graph", () => {
  const installed = readFileSync(interactivePath, "utf8");
  const next = injectInteractiveDeferDialogs(installed);
  assert.match(next, /let createMermaidMarkdownTransformer;/);
  assert.match(next, /let LoginDialogComponent;/);
  assert.match(next, /let AssistantMessageComponent;/);
  assert.match(next, /let ToolExecutionComponent;/);
  assert.match(next, /let SessionSelectorComponent;/);
  assert.match(next, /let TreeSelectorComponent;/);
  assert.doesNotMatch(next, /import \{ createMermaidMarkdownTransformer \} from "\.\/components\/mermaid\.js"/);
  assert.doesNotMatch(next, /import \{ LoginDialogComponent \} from "\.\/components\/login-dialog\.js"/);
  assert.doesNotMatch(next, /import \{ AssistantMessageComponent \} from "\.\/components\/assistant-message\.js"/);
  assert.match(next, /this\.mermaidMarkdownTransformer = undefined;/);
  assert.match(next, /const deferredInteractiveUi = Promise\.all\(/);
  assert.match(next, /import\("\.\/components\/mermaid\.js"\)/);
  assert.match(next, /import\("\.\/components\/assistant-message\.js"\)/);
  assert.match(next, /\.filter\(Boolean\)/);
  assert.throws(
    () => injectInteractiveDeferDialogs("export class InteractiveMode {}"),
    /interactive defer/,
  );
});

test("the boot-perf cluster defers InteractiveMode dialogs without drift", () => {
  const { next, warnings } = applyNoThrow(
    pathToFileURL(interactivePath).href,
    readFileSync(interactivePath, "utf8"),
  );
  assert.equal(warnings.length, 0, `interactive-mode drift: ${warnings.join("; ")}`);
  assert.match(next, /let createMermaidMarkdownTransformer;/);
  assert.match(next, /let AssistantMessageComponent;/);
  assert.match(next, /deferredInteractiveUi/);
});
