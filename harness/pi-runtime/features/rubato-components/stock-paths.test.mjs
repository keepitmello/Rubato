import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import childRuntimeFeature from "../child-runtime/feature.mjs";
import userCommandsSessionFeature from "../user-commands-session/feature.mjs";
import { SOURCE_ASSETS } from "./payload-manifest.mjs";

// Runtime files that import stock Pi package internals. Each lives at
// features/<name>/<file> in the source tree and rubato-features/<name>/<file> in a
// staged candidate; both sit two levels below a root whose node_modules is the install.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = resolvePiRuntime({ root });
const staged = new Map([
  ...childRuntimeFeature.files.map((file) => [file.sourcePath, file.path]),
  ...userCommandsSessionFeature.files.map((file) => [file.sourcePath, file.path]),
  ...Object.entries(SOURCE_ASSETS)
    .filter(([, source]) => source.startsWith("harness/pi-runtime/features/rubato-components/"))
    .map(([path, source]) => [resolve(root, "../..", source), `rubato-features/rubato-components/${path}`]),
]);
const FILES = [
  "features/rubato-components/bootstrap.mjs",
  "features/child-runtime/provider-extension.mjs",
  "features/user-commands-session/tui.mjs",
];

function stockSpecifiers(source) {
  return [...source.matchAll(/(?:from|import\()\s*["']([^"']*@earendil-works\/[^"']+)["']/g)].map((match) => match[1]);
}

function packageOf(specifier) {
  // The innermost package: ".../pi-coding-agent/node_modules/@earendil-works/pi-ai/..." means pi-ai.
  return specifier.match(/@earendil-works\/[^/]+/g).at(-1);
}

test("stock imports in runtime files land in the package Pi itself resolves, from source and staged locations", () => {
  let checked = 0;
  for (const file of FILES) {
    const sourcePath = join(root, file);
    const stagedPath = staged.get(sourcePath);
    assert.ok(stagedPath, `${file} is a staged runtime file`);
    assert.equal(dirname(stagedPath).split("/").length, dirname(file).split("/").length, `${file} keeps its depth when staged`);
    for (const specifier of stockSpecifiers(readFileSync(sourcePath, "utf8"))) {
      const pkg = runtime.packages[packageOf(specifier)];
      assert.ok(pkg, `${file}: ${specifier} names a resolved Pi package`);
      let target;
      if (specifier.startsWith(".")) {
        target = resolve(dirname(sourcePath), specifier);
        // Same file relative to the root either way, so the staged candidate agrees.
        assert.equal(relative(root, target), relative(root, resolve(root, dirname(stagedPath), specifier)), `${file}: ${specifier}`);
      } else {
        target = dirname(findPackageJSON(specifier, pathToFileURL(sourcePath)));
      }
      assert.ok(target === pkg.dir || target.startsWith(pkg.dir + sep), `${file}: ${specifier} resolves outside ${pkg.dir}`);
      checked++;
    }
  }
  assert.ok(checked >= 6, `checked ${checked} stock imports`);
});
