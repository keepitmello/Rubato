// @effect-diagnostics nodeBuiltinImport:off -- A plain vitest file for a plain Electron-side helper.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseLaunchctlPrint, rubatoHarness, serviceStatus } from "./RubatoServices.ts";

// Trimmed `launchctl print gui/<uid>/<label>` output, as macOS 26 prints it.
const running = `gui/501/com.keepitmello.rubato.scheduler = {
\tactive count = 1
\tstate = running
\tpid = 1837
\tlast exit code = (never exited)
}`;
const crashLooping = `gui/501/com.keepitmello.rubato.aside-cursor = {
\tstate = spawn scheduled
\tlast exit code = 1
}`;
const betweenRuns = `gui/501/com.keepitmello.rubato.speed-data = {
\tstate = not running
\tlast exit code = 0
}`;

describe("rubato background services", () => {
  it("reads launchd's own words for a job", () => {
    expect(parseLaunchctlPrint(running)).toEqual({ loaded: true, running: true, lastExit: null });
    expect(parseLaunchctlPrint(crashLooping)).toEqual({ loaded: true, running: false, lastExit: 1 });
    expect(parseLaunchctlPrint(null)).toEqual({ loaded: false, running: false, lastExit: null });
  });

  it("tells a crash loop from a job waiting for its next run, and an unset job from a stopped one", () => {
    expect(serviceStatus(parseLaunchctlPrint(running), true)).toBe("running");
    expect(serviceStatus(parseLaunchctlPrint(crashLooping), true)).toBe("failed");
    expect(serviceStatus(parseLaunchctlPrint(betweenRuns), true, true)).toBe("scheduled");
    expect(serviceStatus(parseLaunchctlPrint(betweenRuns), true)).toBe("stopped");
    expect(serviceStatus(parseLaunchctlPrint(null), true)).toBe("stopped");
    expect(serviceStatus(parseLaunchctlPrint(null), false)).toBe("missing");
  });

  it("finds the checkout's harness from the bridge module the server settings name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rubato-services-"));
    try {
      const settings = path.join(root, "settings.json");
      const bridge = path.join(root, "rubato", "harness", "t3-integration", "src", "bridge.mjs");
      await mkdir(path.dirname(bridge), { recursive: true });
      await writeFile(
        settings,
        JSON.stringify({ providerInstances: { rubato: { config: { bridgeModule: bridge } } } }),
      );
      expect(await rubatoHarness(settings)).toBe(path.join(root, "rubato", "harness"));
      await writeFile(settings, JSON.stringify({ providerInstances: {} }));
      expect(await rubatoHarness(settings)).toBeNull();
      expect(await rubatoHarness(undefined)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
