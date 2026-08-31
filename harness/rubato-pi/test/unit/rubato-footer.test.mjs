import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  RubatoFooter,
  createRubatoFooter,
  injectRubatoFooter,
  isRubatoFooterModuleUrl,
} from "../../src/rubato-footer.mjs";

const interactivePath = join(senpiDir, "dist/modes/interactive/interactive-mode.js");

test("only InteractiveMode is the footer injection target", () => {
  assert.equal(isRubatoFooterModuleUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js"), true);
  assert.equal(isRubatoFooterModuleUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/components/footer.js"), false);
});

test("transform is anchored, idempotent, and fails on pinned-source drift", () => {
  const source = readFileSync(interactivePath, "utf8");
  const once = injectRubatoFooter(source, "file:///rubato-footer.mjs");
  assert.match(once, /__rubatoCreateFooter\(this\.session, this\.footerDataProvider\)/);
  assert.doesNotMatch(once, /this\.footer = this\.chrome/);
  assert.equal(injectRubatoFooter(once, "file:///rubato-footer.mjs"), once);
  assert.throws(
    () => injectRubatoFooter("export class InteractiveMode {}"),
    /footer transform drift/,
  );
});

test("RubatoFooter never paints the senpi cwd/cost line", () => {
  const footer = createRubatoFooter(
    {
      model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      sessionManager: { getCwd: () => "/Users/wy/Github-repos/rubato-lab", getBranch: () => [] },
      getContextUsage: () => ({ tokens: 2, contextWindow: 1_000_000, percent: 0.4 }),
    },
    { getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
  );
  assert.ok(footer instanceof RubatoFooter);
  const text = footer.render(120).join("\n");
  assert.match(text, /✦/);
  assert.doesNotMatch(text, /\$0\.000|\(sub\)|\(auto\)/);
});

test("RubatoFooter stays on a Rubato line when the host painter throws", () => {
  const prev = globalThis[Symbol.for("rubato.pi.footer")];
  try {
    globalThis[Symbol.for("rubato.pi.footer")] = {
      paint() {
        throw new Error("paint boom");
      },
    };
    const footer = createRubatoFooter({
      get model() {
        throw new Error("model boom");
      },
    }, {});
    const text = footer.render(80).join("\n");
    assert.match(text, /✦/);
    assert.doesNotMatch(text, /\$0\.000|\(sub\)/);
  } finally {
    if (prev === undefined) delete globalThis[Symbol.for("rubato.pi.footer")];
    else globalThis[Symbol.for("rubato.pi.footer")] = prev;
  }
});
