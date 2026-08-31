// Flip-readiness audit: after we delete patches/ and reinstall pristine
// node_modules, the real ESM loader must still produce today's final text.
//
// Two-state invariant (see no-changelog-hooks.mjs): cluster transforms run
// first. On a patched install they are inert; on pristine they reconstruct
// the patched bytes (plus the documented in-repo href rewrites). Legacy
// transforms then see the same post-cluster text in both worlds.
//
// Expected final text = patched bytes with the cluster-equality href/import
// rewrites applied, then the leftover legacy transforms. We obtain that by
// running the same load() over the rewritten patched bytes (cluster needles
// are gone, so only legacy remains).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VENDOR_PATCHES, collectPatchLayers, stackByFile } from "../../../../postinstall.mjs";
import { load } from "../../src/no-changelog-hooks.mjs";
import { isEditorMouseTuiUrl } from "../../src/editor-mouse.mjs";
import { isTerminalModuleUrl } from "../../src/title-guard.mjs";
import {
  cursorExecJournalHref,
  rewriteCursorExecJournalImport,
} from "../../src/transforms/cursor-exec-bridge.mjs";
import { assistantInternalActionsHref } from "../../src/transforms/assistant-message.mjs";
import { interactiveChromeHrefs } from "../../src/transforms/interactive-mode-chrome.mjs";
import { toolExecutionInternalActionsHref } from "../../src/transforms/tool-execution.mjs";
import { ALIASES, vendorFileStates } from "./support/vendor-file-states.mjs";

const ALIAS_BY_INDEX = Object.fromEntries(Object.entries(ALIASES).map(([alias, index]) => [index, alias]));

const VENDOR_URL = {
  senpi: (relativePath) => `file:///x/node_modules/@code-yeongyu/senpi/${relativePath}`,
  "senpi-tui": (relativePath) => `file:///x/node_modules/@earendil-works/pi-tui/${relativePath}`,
  "pi-ai": (relativePath) =>
    `file:///x/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/${relativePath}`,
  "senpi-codemode": (relativePath) =>
    `file:///x/node_modules/@code-yeongyu/senpi/node_modules/@code-yeongyu/senpi-codemode/${relativePath}`,
};

// Files a vendor patch creates. The ESM hook cannot invent a new vendor module,
// so importers are rewritten to in-repo hrefs (documented in the cluster
// equality tests). Do not byte-diff these; assert the importer rewrite instead.
const KNOWN_CREATED = new Set([
  "dist/modes/interactive/components/tool-group.js",
  "dist/modes/interactive/components/turn-work-summary.js",
  "dist/modes/interactive/internal-actions.js",
  "dist/core/cursor-exec-journal.js",
]);

// Legacy transforms match these even when no vendor patch touches them.
// Keep them in the audit so a matcher without a patch still has a fixture.
const LEGACY_ONLY = [
  {
    alias: "senpi-tui",
    relativePath: "dist/terminal.js",
    why: "title-guard",
    matches: isTerminalModuleUrl,
  },
  {
    alias: "senpi-tui",
    relativePath: "dist/tui-alt-screen.js",
    why: "editor-mouse + collapsible routing",
    matches: isEditorMouseTuiUrl,
  },
  {
    alias: "senpi",
    relativePath: "dist/modes/interactive/components/settings-selector.js",
    why: "stripChangelog",
    matches: (url) => url.includes("settings-selector.js"),
  },
];

function collectPatchedFiles() {
  const files = [];
  for (const [index, spec] of VENDOR_PATCHES.entries()) {
    const alias = ALIAS_BY_INDEX[index];
    assert.ok(alias, `VENDOR_PATCHES[${index}] must have an ALIASES entry`);
    for (const [relativePath, stack] of stackByFile(collectPatchLayers(spec))) {
      files.push({
        alias,
        relativePath,
        createsFile: stack.some((layer) => layer.createsFile),
      });
    }
  }
  return files;
}

function collectAuditTargets() {
  const patched = collectPatchedFiles();
  const seen = new Set(patched.map((file) => `${file.alias}:${file.relativePath}`));
  const extras = [];
  for (const extra of LEGACY_ONLY) {
    const key = `${extra.alias}:${extra.relativePath}`;
    const url = VENDOR_URL[extra.alias](extra.relativePath);
    assert.equal(extra.matches(url), true, `${key} must still match its legacy predicate`);
    if (seen.has(key)) continue;
    extras.push({ alias: extra.alias, relativePath: extra.relativePath, createsFile: false, legacyOnly: extra.why });
  }
  return [...patched, ...extras];
}

// Cluster equality tests document these four deviations. Reuse their
// replacements with the real in-repo hrefs load() itself injects.
function rewriteKnownHrefs(alias, relativePath, source) {
  if (alias === "senpi" && relativePath === "dist/modes/interactive/components/tool-execution.js") {
    return source.replace('from "../internal-actions.js"', `from ${JSON.stringify(toolExecutionInternalActionsHref())}`);
  }
  if (alias === "senpi" && relativePath === "dist/modes/interactive/components/assistant-message.js") {
    return source.replace('from "../internal-actions.js"', `from ${JSON.stringify(assistantInternalActionsHref())}`);
  }
  if (alias === "senpi" && relativePath === "dist/modes/interactive/interactive-mode.js") {
    const hrefs = interactiveChromeHrefs();
    return source
      .replace('from "./internal-actions.js"', `from ${JSON.stringify(hrefs.internalActions)}`)
      .replace('from "./components/tool-group.js"', `from ${JSON.stringify(hrefs.toolGroup)}`)
      .replace('from "./components/turn-work-summary.js"', `from ${JSON.stringify(hrefs.turnWork)}`);
  }
  if (alias === "senpi" && relativePath === "dist/core/cursor-exec-bridge.js") {
    return rewriteCursorExecJournalImport(source, cursorExecJournalHref());
  }
  return source;
}

function classifyTarget(file) {
  if (file.relativePath.endsWith(".d.ts")) {
    return { kind: "excluded", why: ".d.ts never loads at runtime" };
  }
  if (file.alias === "senpi-codemode" && file.relativePath.startsWith("src/") && file.relativePath.endsWith(".ts")) {
    // jiti path, not the ESM hook — a peer owns the codemode cluster.
    return { kind: "excluded", why: "senpi-codemode src/*.ts is loaded via jiti, not the ESM hook" };
  }
  if (file.createsFile || KNOWN_CREATED.has(file.relativePath)) {
    assert.ok(
      KNOWN_CREATED.has(file.relativePath) || file.relativePath.endsWith(".d.ts"),
      `unknown created vendor file ${file.alias}:${file.relativePath}; decide how to audit it`,
    );
    return { kind: "excluded", why: "created by a patch; loader rewrites importers to in-repo modules" };
  }
  const hasHrefRewrite =
    file.relativePath === "dist/modes/interactive/components/tool-execution.js" ||
    file.relativePath === "dist/modes/interactive/components/assistant-message.js" ||
    file.relativePath === "dist/modes/interactive/interactive-mode.js" ||
    file.relativePath === "dist/core/cursor-exec-bridge.js";
  return { kind: hasHrefRewrite ? "equal-modulo-hrefs" : "chain-equal" };
}

function loaderFor(source) {
  return () => ({ format: "module", source, shortCircuit: true });
}

async function runLoad(url, source) {
  return String((await load(url, {}, loaderFor(source))).source);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const targets = collectAuditTargets();
const audited = [];
const excluded = [];
for (const file of targets) {
  const verdict = classifyTarget(file);
  if (verdict.kind === "excluded") excluded.push({ ...file, ...verdict });
  else audited.push({ ...file, ...verdict });
}

test("audit inventory is enumerated from patches plus legacy matchers", () => {
  assert.ok(targets.length >= 50, `expected a full vendor inventory, got ${targets.length}`);
  assert.ok(audited.length > 0, "audit must compare at least one runtime file");
  assert.ok(
    excluded.some((file) => file.why.startsWith(".d.ts")),
    ".d.ts exclusions must be present so a new types-only patch cannot slip through",
  );
  assert.ok(
    excluded.some((file) => KNOWN_CREATED.has(file.relativePath)),
    "created-file exclusions must be present",
  );
  assert.ok(
    excluded.some((file) => file.alias === "senpi-codemode"),
    "senpi-codemode src/*.ts must be listed and skipped",
  );
  for (const extra of LEGACY_ONLY) {
    assert.ok(
      targets.some((file) => file.alias === extra.alias && file.relativePath === extra.relativePath),
      `legacy-only ${extra.alias}:${extra.relativePath} must stay in the inventory`,
    );
  }
});

for (const file of excluded) {
  test(`excluded ${file.alias}:${file.relativePath} (${file.why})`, () => {
    const pair = vendorFileStates(file.alias, file.relativePath);
    assert.ok(pair, `vendorFileStates(${file.alias}, ${file.relativePath}) must locate the series`);
    if (file.why.startsWith(".d.ts")) {
      assert.match(file.relativePath, /\.d\.ts$/);
      assert.notEqual(pair.pristine, pair.patched, `${file.relativePath} is patched but never loaded`);
      return;
    }
    if (file.why.startsWith("senpi-codemode")) {
      assert.match(file.relativePath, /^src\/.+\.ts$/);
      return;
    }
    assert.equal(pair.pristine, "", `${file.relativePath} is created; pristine must be empty`);
    assert.ok(pair.patched.length > 0, `${file.relativePath} created contents must exist while patches/ is still applied`);
  });
}

for (const file of audited) {
  test(`${file.kind} ${file.alias}:${file.relativePath}`, async () => {
    const pair = vendorFileStates(file.alias, file.relativePath);
    assert.ok(pair, `vendorFileStates(${file.alias}, ${file.relativePath}) must locate the series`);
    const url = VENDOR_URL[file.alias](file.relativePath);
    const expectedBase = rewriteKnownHrefs(file.alias, file.relativePath, pair.patched);
    if (file.kind === "equal-modulo-hrefs") {
      assert.notEqual(expectedBase, pair.patched, `${file.relativePath} must carry the documented href rewrite`);
    } else {
      assert.equal(expectedBase, pair.patched, `${file.relativePath} has no href deviation`);
    }
    const fromPristine = await runLoad(url, pair.pristine);
    const expected = await runLoad(url, expectedBase);
    assert.equal(fromPristine, expected);
  });
}

test("created-file importers point at existing in-repo modules", async () => {
  const hrefs = interactiveChromeHrefs();
  const journal = cursorExecJournalHref();
  const internalFromAssistant = assistantInternalActionsHref();
  const internalFromTool = toolExecutionInternalActionsHref();

  for (const href of [hrefs.internalActions, hrefs.toolGroup, hrefs.turnWork, journal, internalFromAssistant, internalFromTool]) {
    assert.ok(existsSync(fileURLToPath(href)), `missing in-repo module ${href}`);
  }

  const interactive = await runLoad(
    VENDOR_URL.senpi("dist/modes/interactive/interactive-mode.js"),
    vendorFileStates("senpi", "dist/modes/interactive/interactive-mode.js").pristine,
  );
  assert.match(interactive, new RegExp(escapeRegExp(hrefs.internalActions)));
  assert.match(interactive, new RegExp(escapeRegExp(hrefs.toolGroup)));
  assert.match(interactive, new RegExp(escapeRegExp(hrefs.turnWork)));
  assert.doesNotMatch(interactive, /from "\.\/internal-actions\.js"/);
  assert.doesNotMatch(interactive, /from "\.\/components\/tool-group\.js"/);
  assert.doesNotMatch(interactive, /from "\.\/components\/turn-work-summary\.js"/);

  const assistant = await runLoad(
    VENDOR_URL.senpi("dist/modes/interactive/components/assistant-message.js"),
    vendorFileStates("senpi", "dist/modes/interactive/components/assistant-message.js").pristine,
  );
  assert.match(assistant, new RegExp(escapeRegExp(internalFromAssistant)));
  assert.doesNotMatch(assistant, /from "\.\.\/internal-actions\.js"/);

  const toolExecution = await runLoad(
    VENDOR_URL.senpi("dist/modes/interactive/components/tool-execution.js"),
    vendorFileStates("senpi", "dist/modes/interactive/components/tool-execution.js").pristine,
  );
  assert.match(toolExecution, new RegExp(escapeRegExp(internalFromTool)));
  assert.doesNotMatch(toolExecution, /from "\.\.\/internal-actions\.js"/);

  const bridge = await runLoad(
    VENDOR_URL.senpi("dist/core/cursor-exec-bridge.js"),
    vendorFileStates("senpi", "dist/core/cursor-exec-bridge.js").pristine,
  );
  assert.match(bridge, new RegExp(escapeRegExp(journal)));
  assert.doesNotMatch(bridge, /from "\.\/cursor-exec-journal\.js"/);
});
