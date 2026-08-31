import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const root = VENDOR_PATCHES[0].resolveRoot();
const loader = readFileSync(join(root, "dist/core/extensions/loader.js"), "utf8");
const runner = readFileSync(join(root, "dist/core/extensions/runner.js"), "utf8");
const interactive = readFileSync(join(root, "dist/modes/interactive/interactive-mode.js"), "utf8");
const types = readFileSync(join(root, "dist/core/extensions/types.d.ts"), "utf8");

test("ExtensionAPI exposes a lazy interactive control accessor", () => {
  expect(loader).toContain("getInteractiveControl()");
  expect(loader).toContain("return runtime.getInteractiveControl()");
  expect(runner).toContain("setInteractiveControl(surface)");
  expect(types).toContain("export interface InteractiveControlSurface");
});

test("editor submit and the stable facade share one dispatch implementation", () => {
  expect(interactive).toContain('this.defaultEditor.onSubmit = (text) => this.dispatchInteractiveInput(text, [], "editor", "auto")');
  expect(interactive).toContain('await host.dispatchInteractiveInput(text, options.images ?? [], options.source ?? "external", options.delivery ?? "auto")');
  expect(interactive).toContain("this.session.extensionRunner.setInteractiveControl(this.interactiveControlSurface)");
});
