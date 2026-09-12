import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializeProtocolBundle, resolveRemoteProtocolSource } from "./protocol-loader.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("installed remote-surface without a checkout uses the bundled protocol", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "rubato-remote-protocol-install-"));
  try {
    const destDir = join(isolated, "rubato-features", "remote-surface");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(here, "protocol-loader.mjs"), join(destDir, "protocol-loader.mjs"));
    const bundle = materializeProtocolBundle({ dest: join(destDir, "protocol.mjs") });
    assert.equal(bundle, join(destDir, "protocol.mjs"));

    const fromFile = join(destDir, "protocol-loader.mjs");
    const resolved = resolveRemoteProtocolSource({ fromFile, env: {} });
    assert.equal(resolved.source, "bundled");
    assert.equal(resolved.path, join(destDir, "protocol.mjs"));

    const isolatedLoader = await import(pathToFileURL(fromFile).href + "?install-layout");
    const loaded = await isolatedLoader.loadRemoteProtocol({ fromFile, env: {} });
    assert.equal(loaded.source, "bundled");
    assert.equal(typeof loaded.module.encodeFrame, "function");
    assert.equal(typeof loaded.module.REMOTE_PROTOCOL_NAME, "string");
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test("installed layout without a bundled protocol still fails like production", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "rubato-remote-protocol-missing-"));
  try {
    const destDir = join(isolated, "rubato-features", "remote-surface");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(here, "protocol-loader.mjs"), join(destDir, "protocol-loader.mjs"));
    writeFileSync(join(destDir, "index.mjs"), "export {}\n");
    const fromFile = join(destDir, "protocol-loader.mjs");
    assert.throws(
      () => resolveRemoteProtocolSource({ fromFile, env: {} }),
      /rubato-remote-protocol checkout was not found/,
    );
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
