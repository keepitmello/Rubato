import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChildExtensionArgs,
  hasExtension,
  parseExtensionEntries,
} from "../../src/child-args.mjs";

const first = "/app/src/extensions/first-overlay.mjs";
const second = "/app/src/extensions/second-overlay.mjs";

test("parses -e and --extension values from argv", () => {
  assert.deepEqual(
    parseExtensionEntries(["node", "cli.js", "-e", first, "--extension", second, "--mode", "rpc"]),
    [first, second],
  );
});

test("task children keep the full extension list after --no-extensions", () => {
  assert.deepEqual(buildChildExtensionArgs([first, second], false), [
    "--no-extensions",
    "--extension",
    first,
    "--extension",
    second,
  ]);
});

test("DAG children drop the first extension", () => {
  assert.deepEqual(buildChildExtensionArgs([first, second], true), [
    "--no-extensions",
    "--extension",
    second,
  ]);
  assert.equal(hasExtension(["--extension", second], "first-overlay.mjs"), false);
  assert.equal(hasExtension(["--extension", first, "--extension", second], "first-overlay.mjs"), true);
});
