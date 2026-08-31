import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VENDOR_PATCHES } from "../../../../postinstall.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";
import { injectExtensionsLoader } from "../../src/transforms/control-extensions.mjs";
import {
  applyControlCodemodeTransforms,
  injectCodemodeRedirect,
  isExtensionsLoaderUrl,
} from "../../src/transforms/control-codemode.mjs";
import {
  importRubatoCodemode,
  isRubatoCodemodeEntry,
  rubatoCodemodePaths,
} from "../../src/transforms/control-codemode-redirect.mjs";

const SENPI = "@code-yeongyu/senpi/dist";
const paths = rubatoCodemodePaths();

test("in-repo codemode copies are byte-equal to the patched vendor files", () => {
  const index = vendorFileStates("senpi-codemode", "src/index.ts");
  const notifier = vendorFileStates("senpi-codemode", "src/extension/eval-notifier.ts");
  assert.ok(index && notifier);
  assert.notEqual(index.pristine, index.patched);
  assert.notEqual(notifier.pristine, notifier.patched);
  assert.equal(readFileSync(paths.index, "utf8"), index.patched);
  assert.equal(readFileSync(paths.notifier, "utf8"), notifier.patched);
});

test("redirect needles exist on both pristine and patched loader.js", () => {
  const states = vendorFileStates("senpi", "dist/core/extensions/loader.js");
  assert.ok(states);
  const onPristine = injectCodemodeRedirect(states.pristine);
  const onPatched = injectCodemodeRedirect(states.patched);
  assert.equal(injectCodemodeRedirect(injectExtensionsLoader(states.pristine)), onPatched);
  assert.match(onPristine, /evalModule/);
  assert.match(onPristine, /senpi-codemode:detached-eval/.test(readFileSync(paths.notifier, "utf8")) ? /eval-notifier\.ts/ : /eval-notifier\.ts/);
  assert.match(onPristine, /codemode\/index\.ts/);
  assert.match(onPristine, /codemode\/extension\/eval-notifier\.ts/);
  assert.throws(() => injectCodemodeRedirect("export function loadExtensions() {}"), /codemode jiti notifier alias/);
});

test("applyControlCodemodeTransforms applies redirect on already-patched loader", () => {
  const { patched } = vendorFileStates("senpi", "dist/core/extensions/loader.js");
  const warnings = [];
  const applyTransform = (source, transform) => {
    try {
      const next = transform(source);
      return typeof next === "string" ? next : source;
    } catch (error) {
      warnings.push(error.message);
      return source;
    }
  };
  const url = `file:///x/${SENPI}/core/extensions/loader.js`;
  assert.equal(isExtensionsLoaderUrl(url), true);
  const next = applyControlCodemodeTransforms(url, patched, applyTransform);
  assert.match(next, /evalModule/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /extensions loader runtime/);
});

test("redirected jiti load uses in-repo entry and notifier; other files stay vendor", async () => {
  const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
  const codeRoot = VENDOR_PATCHES[3].resolveRoot();
  const vendorIndex = join(codeRoot, "src/index.ts");
  const vendorNotifier = join(codeRoot, "src/extension/eval-notifier.ts");
  assert.equal(isRubatoCodemodeEntry(vendorIndex), true);

  const jitiHref = pathToFileURL(join(senpiRoot, "node_modules/jiti/lib/jiti-static.mjs")).href;
  const { createJiti } = await import(jitiHref);
  const loaderUrl = pathToFileURL(join(senpiRoot, "dist/core/extensions/loader.js")).href;
  const req = createRequire(join(senpiRoot, "dist/core/extensions/loader.js"));
  const fsCjs = req("fs");
  const orig = fsCjs.readFileSync;
  const reads = [];
  fsCjs.readFileSync = function(p, ...rest) {
    const s = String(p);
    if (s.endsWith(".ts") && (s.includes("senpi-codemode") || s.includes("/codemode/"))) reads.push(s);
    return orig.call(this, p, ...rest);
  };

  const jiti = createJiti(loaderUrl, {
    moduleCache: false,
    alias: { "./extension/eval-notifier.ts": paths.notifier },
  });
  let factory;
  try {
    factory = await importRubatoCodemode(jiti, vendorIndex);
  } finally {
    fsCjs.readFileSync = orig;
  }

  assert.equal(typeof factory, "function");
  assert.equal(reads.includes(paths.notifier), true);
  assert.equal(reads.includes(vendorNotifier), false);
  assert.equal(reads.includes(vendorIndex), false);
  assert.ok(reads.some((file) => file.endsWith("/senpi-codemode/src/completion/handler.ts")));

  const notifierMod = await createJiti(loaderUrl, { moduleCache: false }).import(paths.notifier);
  assert.equal(notifierMod.DETACHED_EVAL_MESSAGE_TYPE, "senpi-codemode:detached-eval");
  const sent = [];
  const notifier = new notifierMod.EvalNotifier({
    sendMessage: (message, options) => sent.push({ message, options }),
    getContext: () => ({ mode: "interactive", model: { id: "x" } }),
    getMode: () => "wake",
  });
  notifier.notify([{ cellId: "c1", content: "hello-cell" }]);
  assert.deepEqual(sent, [{
    message: {
      customType: "senpi-codemode:detached-eval",
      content: "hello-cell",
      display: false,
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  }]);
});
