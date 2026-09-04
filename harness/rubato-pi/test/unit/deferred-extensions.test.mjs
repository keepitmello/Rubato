import test from "node:test";
import assert from "node:assert/strict";
import { isHeadlessCli } from "../../src/cli-headless.mjs";
import {
  activateDeferredExtensions,
  hasFinishedFirstPaintDeferral,
  registerDeferredExtension,
  resetDeferredExtensionsForTests,
  runOrDeferExtension,
  shouldDeferExtensionActivation,
} from "../../src/deferred-extensions.mjs";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("headless CLI covers print, json, rpc, and app-server", () => {
  assert.equal(isHeadlessCli([]), false);
  assert.equal(isHeadlessCli(["--print", "hi"]), true);
  assert.equal(isHeadlessCli(["-p", "hi"]), true);
  assert.equal(isHeadlessCli(["--mode", "json"]), true);
  assert.equal(isHeadlessCli(["--mode=print"]), true);
  assert.equal(isHeadlessCli(["--mode", "rpc"]), true);
  assert.equal(isHeadlessCli(["--mode=rpc"]), true);
  assert.equal(isHeadlessCli(["app-server"]), true);
  assert.equal(isHeadlessCli(["--model", "xai/grok-4.6"]), false);
});

test("only an interactive TTY defers extension activation", () => {
  assert.equal(shouldDeferExtensionActivation([], tty, tty), true);
  assert.equal(shouldDeferExtensionActivation(["--print", "hi"], tty, tty), false);
  assert.equal(shouldDeferExtensionActivation(["--mode", "rpc"], tty, tty), false);
  assert.equal(shouldDeferExtensionActivation(["--mode=print"], tty, tty), false);
  assert.equal(shouldDeferExtensionActivation([], pipe, tty), false);
  assert.equal(shouldDeferExtensionActivation([], tty, pipe), false);
});

test("team member processes never defer", () => {
  const prev = process.env.SENPI_TASK_MEMBER;
  process.env.SENPI_TASK_MEMBER = "probe-member";
  try {
    assert.equal(shouldDeferExtensionActivation([], tty, tty), false);
  } finally {
    if (prev === undefined) delete process.env.SENPI_TASK_MEMBER;
    else process.env.SENPI_TASK_MEMBER = prev;
  }
});

test("activate runs each registered starter once", async () => {
  resetDeferredExtensionsForTests();
  const log = [];
  registerDeferredExtension(async () => {
    log.push("a");
  });
  registerDeferredExtension(async () => {
    log.push("b");
  });
  await activateDeferredExtensions();
  await activateDeferredExtensions();
  assert.deepEqual(log, ["a", "b"]);
  assert.equal(hasFinishedFirstPaintDeferral(), true);
});

test("after first paint a new factory attaches immediately, like /resume", async () => {
  resetDeferredExtensionsForTests();
  await activateDeferredExtensions();
  const log = [];
  await runOrDeferExtension(async () => {
    log.push("resume");
  });
  assert.deepEqual(log, ["resume"]);
});
