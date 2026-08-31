// codemode jiti 리다이렉트: senpi-codemode 는 source-only TS 라 ESM 훅이 못 닿고,
// loader.js 변환이 jiti 에 in-repo 패치본(index.ts + eval-notifier.ts)을 먹인다.
// 설치본은 pristine 이고, 패치의 관찰 가능한 행동(detached eval 을 custom message
// 로 보내 Steering 라벨을 피함)은 in-repo 사본이 싣는다.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
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

const paths = rubatoCodemodePaths();
const loaderPath = join(senpiDir, "dist", "core", "extensions", "loader.js");

test("redirect needles land on the installed loader.js", () => {
  const installed = readFileSync(loaderPath, "utf8");
  const next = injectCodemodeRedirect(injectExtensionsLoader(installed));
  assert.match(next, /evalModule/);
  assert.match(next, /codemode\/index\.ts/);
  assert.match(next, /codemode\/extension\/eval-notifier\.ts/);
  assert.throws(() => injectCodemodeRedirect("export function loadExtensions() {}"), /codemode jiti notifier alias/);
});

test("the control cluster applies loader inject and redirect without drift", () => {
  const installed = readFileSync(loaderPath, "utf8");
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
  const url = pathToFileURL(loaderPath).href;
  assert.equal(isExtensionsLoaderUrl(url), true);
  const next = applyControlCodemodeTransforms(url, installed, applyTransform);
  assert.match(next, /evalModule/);
  assert.match(next, /getInteractiveControl/);
  assert.deepEqual(warnings, []);
});

test("redirected jiti load uses in-repo entry and notifier; other files stay vendor", async () => {
  const codeRoot = senpiNested("@code-yeongyu", "senpi-codemode");
  const vendorIndex = join(codeRoot, "src/index.ts");
  const vendorNotifier = join(codeRoot, "src/extension/eval-notifier.ts");
  assert.equal(isRubatoCodemodeEntry(vendorIndex), true);

  const jitiHref = pathToFileURL(join(senpiDir, "node_modules/jiti/lib/jiti-static.mjs")).href;
  const { createJiti } = await import(jitiHref);
  const loaderUrl = pathToFileURL(loaderPath).href;
  const req = createRequire(loaderPath);
  const fsCjs = req("fs");
  const orig = fsCjs.readFileSync;
  const reads = [];
  fsCjs.readFileSync = function (p, ...rest) {
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
