import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { senpiDir } from "../../src/engine-paths.mjs";
import { applyBootPerfTransforms } from "../../src/transforms/boot-perf.mjs";
import {
  injectLoaderDeferHeavyBundles,
  isBootLoaderUrl,
} from "../../src/transforms/boot-loader-defer.mjs";
import { injectAgentSessionDeferExportHtml } from "../../src/transforms/boot-agent-session-export.mjs";
import { injectMainDeferCliModules } from "../../src/transforms/boot-main-defer.mjs";

const loaderPath = join(senpiDir, "dist", "core", "extensions", "loader.js");
const agentSessionPath = join(senpiDir, "dist", "core", "agent-session.js");
const mainPath = join(senpiDir, "dist", "main.js");

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

test("defer needles land on the installed loader.js", () => {
  const installed = readFileSync(loaderPath, "utf8");
  const next = injectLoaderDeferHeavyBundles(installed);
  assert.match(next, /const _bundledPiCodingAgent = \{\};/);
  assert.match(next, /const _bundledPiAiProviders = \{\};/);
  assert.match(next, /const _bundledTypebox = \{\};/);
  assert.doesNotMatch(next, /import \* as _bundledPiCodingAgent from "\.\.\/\.\.\/index\.js"/);
  assert.doesNotMatch(next, /import \* as _bundledPiAiProviders from "@earendil-works\/pi-ai\/providers\/all"/);
  assert.throws(
    () => injectLoaderDeferHeavyBundles("export function loadExtensions() {}"),
    /loader defer pi-ai oauth\/providers/,
  );
});

test("export-html needles land on the installed agent-session.js", () => {
  const installed = readFileSync(agentSessionPath, "utf8");
  const next = injectAgentSessionDeferExportHtml(installed);
  assert.doesNotMatch(next, /import \{ exportSessionToHtml \} from "\.\/export-html\/index\.js"/);
  assert.match(next, /await import\("\.\/export-html\/index\.js"\)/);
  assert.throws(
    () => injectAgentSessionDeferExportHtml("export class AgentSession {}"),
    /agent-session defer export-html imports/,
  );
});

test("CLI defer needles land on the installed main.js", () => {
  const installed = readFileSync(mainPath, "utf8");
  const next = injectMainDeferCliModules(installed);
  assert.match(next, /import \{ InteractiveMode \} from "\.\/modes\/interactive\/interactive-mode\.js"/);
  assert.doesNotMatch(next, /from "\.\/modes\/index\.js"/);
  assert.match(next, /args\[0\] === "install"/);
  assert.doesNotMatch(next, /import \{ exportFromFile \}/);
  assert.doesNotMatch(next, /import \{ handleConfigCommand, handlePackageCommand \}/);
  assert.match(next, /await import\("\.\/package-manager-cli\.js"\)/);
  assert.match(next, /await import\("\.\/core\/export-html\/index\.js"\)/);
  assert.doesNotMatch(next, /from "\.\/cli\/startup-ui\.js"/);
  assert.doesNotMatch(next, /from "\.\/cli\/auth-command\.js"/);
  assert.match(next, /if \(args\[0\] !== "auth"\)/);
  assert.match(next, /await import\("\.\/cli\/startup-ui\.js"\)/);
  assert.throws(
    () => injectMainDeferCliModules("export async function main() {}"),
    /main defer auth-check import/,
  );
});

test("the boot-perf cluster applies loader/main/agent-session without drift", () => {
  for (const rel of [
    ["dist/core/extensions/loader.js", /const _bundledPiCodingAgent = \{\};/],
    ["dist/core/agent-session.js", /await import\("\.\/export-html\/index\.js"\)/],
    ["dist/main.js", /import \{ InteractiveMode \} from "\.\/modes\/interactive\/interactive-mode\.js"/],
  ]) {
    const filePath = join(senpiDir, rel[0]);
    const { next, warnings } = applyNoThrow(pathToFileURL(filePath).href, readFileSync(filePath, "utf8"));
    assert.equal(warnings.length, 0, `${rel[0]} drift: ${warnings.join("; ")}`);
    assert.match(next, rel[1]);
  }
});
