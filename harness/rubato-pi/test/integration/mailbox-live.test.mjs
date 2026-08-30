import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { probeRpc } from "../helpers/rpc-surface.mjs";
import {
  claimInbox,
  inboxDir,
  isProcessed,
  mailboxPaths,
  reclaimStaleReserved,
  writeInbox,
} from "../../src/mailbox.mjs";

test("a reserved mailbox file survives a live lead process and can be reclaimed once", { timeout: 60_000 }, async () => {
  const surface = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
  });
  const dir = inboxDir(surface.home, "11111111-1111-4111-8111-111111111111", "owner-a");
  await writeInbox(dir, "live-crash", { text: "inject" });
  const claimed = await claimInbox(dir, "live-crash");
  assert.equal(claimed.kind, "claimed");
  const again = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
    env: { HOME: surface.home, SENPI_CODING_AGENT_DIR: `${surface.home}/agent` },
  });
  assert.ok(again.extensionCommands.includes("tasks"));
  assert.equal(existsSync(mailboxPaths(dir, "live-crash").reservedPath), true);
  assert.equal(await isProcessed(dir, "live-crash"), false);
  const reclaimed = await reclaimStaleReserved(dir, 0);
  assert.deepEqual(reclaimed, ["live-crash"]);
  const second = await claimInbox(dir, "live-crash");
  assert.equal(second.kind, "claimed");
});
