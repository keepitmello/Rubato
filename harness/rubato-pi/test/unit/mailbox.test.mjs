import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimInbox,
  commitDelivery,
  inboxDir,
  isProcessed,
  reclaimStaleReserved,
  writeInbox,
} from "../../src/mailbox.mjs";

test("commit is exactly-once and a crash before commit can be reclaimed once", async () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-mbox-"));
  const dir = inboxDir(root, "11111111-1111-4111-8111-111111111111", "owner-a");
  await writeInbox(dir, "m1", { text: "hello" });
  const first = await claimInbox(dir, "m1");
  assert.equal(first.kind, "claimed");
  const reclaimed = await reclaimStaleReserved(dir, 0);
  assert.deepEqual(reclaimed, ["m1"]);
  const second = await claimInbox(dir, "m1");
  assert.equal(second.kind, "claimed");
  await commitDelivery(second.paths);
  assert.equal(await isProcessed(dir, "m1"), true);
  assert.equal((await claimInbox(dir, "m1")).kind, "already_processed");
});

test("fresh reserved files are not reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-mbox-fresh-"));
  const dir = inboxDir(root, "11111111-1111-4111-8111-111111111111", "owner-a");
  await writeInbox(dir, "m2", { text: "live" });
  await claimInbox(dir, "m2");
  const reclaimed = await reclaimStaleReserved(dir, 60_000);
  assert.deepEqual(reclaimed, []);
});
