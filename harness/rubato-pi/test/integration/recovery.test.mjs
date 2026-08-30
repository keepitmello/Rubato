import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { probeRpc } from "../helpers/rpc-surface.mjs";
import { claimInbox, inboxDir, isProcessed, reclaimStaleReserved, writeInbox } from "../../src/mailbox.mjs";

test("the same isolated agent dir can be opened twice after a kill", { timeout: 60_000 }, async () => {
  const first = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
  });
  const ledgerDir = join(first.home, "agent", "processed");
  mkdirSync(ledgerDir, { recursive: true });
  const messageId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(ledgerDir, `${messageId}.json`), `${JSON.stringify({ messageId, once: true })}\n`);
  const second = await probeRpc({
    nodeBin: process.execPath,
    senpiCli: senpiCliPath(),
    extensionArgs: ["-e", leadOverlayPath(), "-e", adapterPath()],
    env: { SENPI_CODING_AGENT_DIR: join(first.home, "agent"), HOME: first.home },
  });
  assert.ok(second.extensionCommands.includes("tasks"));
  const kept = JSON.parse(readFileSync(join(ledgerDir, `${messageId}.json`), "utf8"));
  assert.equal(kept.once, true);

  const box = inboxDir(first.home, "11111111-1111-4111-8111-111111111111", "owner-a");
  await writeInbox(box, "mid-crash", { text: "inject" });
  const claimed = await claimInbox(box, "mid-crash");
  assert.equal(claimed.kind, "claimed");
  assert.equal(existsSync(claimed.paths.reservedPath), true);
  const reclaimed = await reclaimStaleReserved(box, 0);
  assert.deepEqual(reclaimed, ["mid-crash"]);
  assert.equal(await isProcessed(box, "mid-crash"), false);
});
