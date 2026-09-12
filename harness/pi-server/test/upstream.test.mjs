import assert from "node:assert/strict";
import test from "node:test";
import * as server from "@earendil-works/pi-server";
import * as unix from "@earendil-works/pi-server/unix";
import * as client from "@earendil-works/pi-client";
import * as chord from "@earendil-works/chord";

test("pinned published packages expose the routed server contract", () => {
  assert.equal(typeof server.Server, "function");
  assert.equal(typeof server.SessionNotFoundError, "function");
  assert.equal(typeof unix.createUnixServer, "function");
  assert.equal(typeof unix.getUnixSocketPath, "function");
  assert.equal(typeof client.Client, "function");
  console.log(JSON.stringify({ server: Object.keys(server), client: Object.keys(client), chord: Object.keys(chord) }));
});
