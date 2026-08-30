import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import {
  nvmVersionsRoot,
  parseVersionText,
  pickNode,
  runningNode,
  versionFromPath,
  versionOf,
} from "../../src/select-node.mjs";

const NVM = "/x/.nvm/versions/node";

test("versionFromPath reads an nvm layout and ignores junk names", () => {
  const parsed = versionFromPath(`${NVM}/v24.18.0/bin/node`, { nvmRoot: NVM });
  assert.equal(parsed.major, 24);
  assert.equal(parsed.minor, 18);
  assert.equal(parsed.patch, 0);
  assert.equal(parsed.text, "v24.18.0");
  assert.equal(versionFromPath(`${NVM}/.DS_Store/bin/node`, { nvmRoot: NVM }), null);
  assert.equal(versionFromPath("/opt/homebrew/bin/node", { nvmRoot: NVM }), null);
  assert.equal(versionFromPath("/opt/fake/v24.18.0/bin/node", { nvmRoot: NVM }), null);
});

test("versionOf uses the nvm path instead of spawning when the file exists", () => {
  const bin = process.execPath;
  const root = nvmVersionsRoot();
  if (!bin.startsWith(`${root}/`) || !existsSync(bin)) return;
  const got = versionOf(bin);
  assert.equal(got.text, process.version);
  assert.equal(got.bin, realpathSync(bin));
});

test("runningNode accepts the current process when it is already 24+", () => {
  const got = runningNode();
  assert.ok(got);
  assert.ok(got.major >= 24);
  assert.equal(got.bin, realpathSync(process.execPath));
  assert.equal(runningNode({ version: "v22.19.0", execPath: process.execPath }), null);
  assert.equal(runningNode({ version: "v24.18.0", execPath: "/no/such/node" }), null);
});

test("pickNode prefers 24 over a newer major", () => {
  const versions = new Map([
    ["/x/v22/bin/node", { bin: "/x/v22/bin/node", text: "v22.19.0", major: 22, minor: 19, patch: 0 }],
    ["/x/v25/bin/node", { bin: "/x/v25/bin/node", text: "v25.1.0", major: 25, minor: 1, patch: 0 }],
    ["/x/v24/bin/node", { bin: "/x/v24/bin/node", text: "v24.18.0", major: 24, minor: 18, patch: 0 }],
  ]);
  const picked = pickNode([...versions.keys()], { version: (bin) => versions.get(bin) ?? null });
  assert.equal(picked.bin, "/x/v24/bin/node");
  assert.equal(picked.major, 24);
});
