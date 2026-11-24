// @effect-diagnostics nodeBuiltinImport:off -- the files under test are the bridge's plain files.
// The GUI's half of rewind on agy's own store: the files it leaves for the approval bridge
// (harness/t3-integration/agy-native.mjs reads `cuts/<session>.json` and writes
// `batches/<session>.json`), and how a session shows it rewinds natively.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "vite-plus/test";

import { agyBatchEnd, agyNativeDir, agyRewindsNatively, writeAgyCut } from "./RubatoAgyNative.ts";
import { rubatoAgyNativeRollback } from "./RubatoAgyNativeRollback.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rubato-agy-native-"));
  made.push(dir);
  return dir;
};

it("the folder is the configured one, else under the user's Rubato home", () => {
  expect(agyNativeDir({ RUBATO_AGY_NATIVE_DIR: "/tmp/x" })).toBe("/tmp/x");
  expect(agyNativeDir({})).toBe(path.join(os.homedir(), ".rubato", "agy-native"));
});

it("each cut is its own file in the session's folder, the latest sorting last", async () => {
  const dir = await tempDir();
  // Back to back, often within one millisecond: the later write still sorts last.
  await writeAgyCut("s-1", { throughTime: "2026-11-24T11:00:05.000Z" }, dir);
  await writeAgyCut("s-1", { throughToolCallId: "call_1", batchEnd: "call_2" }, dir);
  const names = (await readdir(path.join(dir, "cuts", "s-1"))).toSorted();
  expect(names).toHaveLength(2);
  const saved = JSON.parse(await readFile(path.join(dir, "cuts", "s-1", names[1]!), "utf8"));
  expect(saved).toMatchObject({ sessionId: "s-1", keep: { throughToolCallId: "call_1", batchEnd: "call_2" } });
  expect(typeof saved.id).toBe("string");
  await expect(writeAgyCut("../escape", { throughTime: "x" }, dir)).rejects.toThrow(/Not an agy session id/);
});

it("a batch end is the bridge's answer, and unknown otherwise", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, "batches"), { recursive: true });
  await writeFile(path.join(dir, "batches", "s-1.json"), JSON.stringify({ batches: { a: "b", b: "b" } }));
  expect(await agyBatchEnd("s-1", "a", dir)).toBe("b");
  expect(await agyBatchEnd("s-1", "c", dir)).toBeUndefined();
  expect(await agyBatchEnd("s-2", "a", dir)).toBeUndefined();
});

it("only an agy answered through the bridge rewinds natively", () => {
  const through = { agentCapabilities: { _meta: { antigravity: {}, rubato: { nativeRewind: true } } } };
  expect(agyRewindsNatively(through)).toBe(true);
  expect(agyRewindsNatively({ agentCapabilities: { _meta: { antigravity: {} } } })).toBe(false);
  expect(agyRewindsNatively(undefined)).toBe(false);
  expect(rubatoAgyNativeRollback.forkMeta("2026-11-24T11:00:05.000Z")).toEqual({
    rubato: { keepThroughTime: "2026-11-24T11:00:05.000Z" },
  });
});

it("the adapter's cut keeps the session through a turn's end", async () => {
  const dir = await tempDir();
  const previous = process.env.RUBATO_AGY_NATIVE_DIR;
  process.env.RUBATO_AGY_NATIVE_DIR = dir;
  try {
    await Effect.runPromise(
      rubatoAgyNativeRollback.cut({ sessionId: "s-3", keepThroughTime: "2026-11-24T11:00:05.000Z" }),
    );
  } finally {
    if (previous === undefined) delete process.env.RUBATO_AGY_NATIVE_DIR;
    else process.env.RUBATO_AGY_NATIVE_DIR = previous;
  }
  const [name] = await readdir(path.join(dir, "cuts", "s-3"));
  const saved = JSON.parse(await readFile(path.join(dir, "cuts", "s-3", name!), "utf8"));
  expect(saved.keep).toEqual({ throughTime: "2026-11-24T11:00:05.000Z" });
});
