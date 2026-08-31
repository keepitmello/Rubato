import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultLifecycle, parseNewArguments, runCli } from "../src/cli.mjs";
import { HubLifecycleClient } from "../src/hub-client.mjs";

test("new options stop at -- and preserve engine argv exactly", () => {
  assert.deepEqual(
    parseNewArguments(["--cwd", "/tmp/project", "--name=Demo", "--detach", "--", "prompt", "--model", "xai/grok-4.6"]),
    {
      cwd: "/tmp/project",
      name: "Demo",
      detach: true,
      args: ["prompt", "--model", "xai/grok-4.6"],
    },
  );
  assert.throws(() => parseNewArguments(["--unknown"]), /unknown/);
});

test("list JSON exposes lifecycle records without recomputing session state", async () => {
  let output = "";
  const session = {
    liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
    zmxName: "rubato-018f0c7b2f3b",
    title: "Demo",
    cwd: "/tmp/project",
    sessionFile: "/tmp/session.jsonl",
    managed: true,
  };
  const lifecycle = { list: () => [session] };
  const code = await runCli(["list", "--json"], {
    lifecycle,
    baseline: {},
    stdout: { write(value) { output += value; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), [session]);
});

test("default lifecycle is the hub control client, never a local process owner", () => {
  assert.ok(createDefaultLifecycle({ env: { RUBATO_HUB_SOCKET: "/tmp/hub.sock" } }) instanceof HubLifecycleClient);
});

test("bare picker consumes hub summaries and routes the selected canonical live id", async () => {
  const session = { liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", title: "Demo", cwd: "/tmp", lifecycle: "ready", model: { label: "Opus" } };
  const calls = [];
  await runCli(["pick"], {
    lifecycle: { list: async () => [session], attach: async (id) => calls.push(id) },
    picker: async (summaries) => {
      assert.equal(summaries[0], session);
      return { kind: "attach", liveSessionId: session.liveSessionId };
    },
  });
  assert.deepEqual(calls, [session.liveSessionId]);
});

test("remote production doctor, update guard path, and confirmed uninstall are publicly routed", async () => {
  let output = "";
  const calls = [];
  const remoteOperations = {
    doctor: async () => ({ result: { ok: true, checks: [] }, exitCode: 0 }),
    guardUpdate: async () => { calls.push(["guard-update"]); return { result: { safe: true }, exitCode: 0 }; },
    update: async (args) => { calls.push(["update", ...args]); return { result: { liveSessionsPreserved: 2 }, exitCode: 0 }; },
    uninstall: async (args) => { calls.push(["uninstall", ...args]); return { result: { uninstalled: true }, exitCode: 0 }; },
  };
  const options = { lifecycle: {}, remoteOperations, stdout: { write: (value) => { output += value; } } };
  assert.equal(await runCli(["remote", "doctor"], options), 0);
  assert.equal(await runCli(["remote", "update-guard"], options), 0);
  assert.equal(await runCli(["remote", "update", "--release", "/tmp/signed", "--force-live"], options), 0);
  assert.equal(await runCli(["remote", "uninstall", "--yes", "--remove-push"], options), 0);
  assert.deepEqual(calls, [
    ["guard-update"],
    ["update", "--release", "/tmp/signed", "--force-live"],
    ["uninstall", "--yes", "--remove-push"],
  ]);
  await assert.rejects(() => runCli(["remote", "uninstall"], options), /requires --yes/);
  assert.equal(output.trim().split("\n").length, 3);
});

test("remote add-host and internal-run route without loading the engine", async () => {
  let output = "";
  const calls = [];
  await runCli(["remote", "add-host"], {
    lifecycle: { addHost: async () => ({ pairing: { type: "rubato-host-pair", hostId: "host", nonce: "once" }, url: "https://mac/rubato/?pair=data", qrPayload: "{\"type\":\"rubato-host-pair\"}" }) },
    stdout: { write: (value) => { output += value; } },
  });
  await runCli(["internal-run", "--descriptor", "/tmp/descriptor"], {
    lifecycle: {},
    bootstrap: async (path) => calls.push(path),
  });
  assert.deepEqual(output.trim().split("\n"), ["https://mac/rubato/?pair=data", "{\"type\":\"rubato-host-pair\"}"]);
  assert.deepEqual(calls, ["/tmp/descriptor"]);
});
