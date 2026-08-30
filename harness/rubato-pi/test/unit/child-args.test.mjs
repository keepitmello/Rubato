import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChildExtensionArgs,
  hasExtension,
  parseExtensionEntries,
} from "../../src/child-args.mjs";

const lead = "/app/src/extensions/lead-overlay.mjs";
const adapter = "/app/src/extensions/adapter.mjs";

test("parses -e and --extension values from argv", () => {
  assert.deepEqual(
    parseExtensionEntries(["node", "cli.js", "-e", lead, "--extension", adapter, "--mode", "rpc"]),
    [lead, adapter],
  );
});

test("task children keep the full extension list after --no-extensions", () => {
  assert.deepEqual(buildChildExtensionArgs([lead, adapter], false), [
    "--no-extensions",
    "--extension",
    lead,
    "--extension",
    adapter,
  ]);
});

test("DAG children drop the first extension", () => {
  assert.deepEqual(buildChildExtensionArgs([lead, adapter], true), [
    "--no-extensions",
    "--extension",
    adapter,
  ]);
  assert.equal(hasExtension(["--extension", adapter], "lead-overlay.mjs"), false);
  assert.equal(hasExtension(["--extension", lead, "--extension", adapter], "lead-overlay.mjs"), true);
});
