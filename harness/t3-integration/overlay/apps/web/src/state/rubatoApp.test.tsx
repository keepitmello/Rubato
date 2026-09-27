import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const postRubato = vi.fn();
vi.mock("./rubatoHttp", () => ({ postRubato: (...args: unknown[]) => postRubato(...args) }));
vi.mock("./environments", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePrimaryEnvironmentId: () => "mac",
}));
vi.mock("./session", async (importOriginal) => {
  const Option = await import("effect/Option");
  return { ...(await importOriginal<object>()), usePreparedConnection: () => Option.some({}) };
});

const { __resetRubatoUpdateCheckForTests, checkRubatoUpdate, useRubatoUpdateCheck } = await import("./rubatoApp");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RubatoUpdateDot, waitForRestart } = await import("../components/settings/RubatoAboutSection");

const mac = "mac" as EnvironmentId;
const update = { available: true, commits: 2, changes: [] };

function Probe({ environmentId }: { environmentId: EnvironmentId | null }) {
  const { check, error } = useRubatoUpdateCheck(environmentId);
  return <p>{error ?? (check ? `available=${check.available}` : "none")}</p>;
}

// Settings reads one check: the nav dot next to General and the About rows share it,
// so opening Settings does not fetch the Rubato checkout twice.
describe("the shared Rubato update check", () => {
  beforeEach(() => {
    __resetRubatoUpdateCheckForTests();
    postRubato.mockReset();
    postRubato.mockResolvedValue(update);
  });
  afterEach(() => vi.useRealTimers());

  it("reuses a fresh result and checks again when asked", async () => {
    await Promise.all([checkRubatoUpdate(mac, false), checkRubatoUpdate(mac, false)]);
    await checkRubatoUpdate(mac, false);
    expect(postRubato).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(<Probe environmentId={mac} />)).toContain("available=true");

    await checkRubatoUpdate(mac, true);
    expect(postRubato).toHaveBeenCalledTimes(2);
  });

  it("checks again once the result is ten minutes old", async () => {
    vi.useFakeTimers({ now: 0 });
    await checkRubatoUpdate(mac, false);
    vi.setSystemTime(10 * 60_000);
    await checkRubatoUpdate(mac, false);
    expect(postRubato).toHaveBeenCalledTimes(2);
  });

  it("does not show one environment's result for another", async () => {
    await checkRubatoUpdate(mac, false);
    expect(renderToStaticMarkup(<Probe environmentId={"other" as EnvironmentId} />)).toContain("none");
  });

  it("keeps the failure reason and retries on the next open", async () => {
    postRubato.mockRejectedValueOnce(new Error("offline"));
    await checkRubatoUpdate(mac, false);
    expect(renderToStaticMarkup(<Probe environmentId={mac} />)).toContain("offline");
    await checkRubatoUpdate(mac, false);
    expect(postRubato).toHaveBeenCalledTimes(2);
  });

  it("marks General in the settings nav only while an update is waiting", async () => {
    postRubato.mockResolvedValueOnce({ available: false, commits: 0, changes: [] });
    await checkRubatoUpdate(mac, false);
    expect(renderToStaticMarkup(<RubatoUpdateDot />)).toBe("");

    await checkRubatoUpdate(mac, true);
    expect(renderToStaticMarkup(<RubatoUpdateDot />)).toContain("Rubato update available: 2 new changes");
  });
});

// About follows its restart until the job reports: a failure before the app quits
// frees the button with the reason instead of leaving it spinning.
describe("following a restart from About", () => {
  const status = (result: object | null, busy = false) => ({ busy, result, log: "/logs/update.log" });
  beforeEach(() => postRubato.mockReset());
  afterEach(() => vi.useRealTimers());

  it("reports the failure of its own job, not an older one", async () => {
    postRubato
      .mockResolvedValueOnce(status({ token: "old", kind: "update", status: "failed", message: "old failure" }, true))
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(status({ token: "mine", kind: "restart", status: "failed", message: "The restart did not finish (1)." }));
    const outcome = await waitForRestart(mac, "mine", 1);
    expect(outcome).toEqual({ failed: true, message: "The restart did not finish (1).", log: "/logs/update.log" });
  });

  it("ends quietly when its job succeeds without an app to reopen", async () => {
    postRubato.mockResolvedValue(status({ token: "mine", kind: "restart", status: "succeeded", message: null }));
    expect((await waitForRestart(mac, "mine", 1)).failed).toBe(false);
  });

  it("says the restart never started when no job took the lock", async () => {
    vi.useFakeTimers({ now: 0 });
    postRubato.mockResolvedValue(status({ token: "other", kind: "update", status: "succeeded", message: null }));
    const outcome = waitForRestart(mac, "mine", 1_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(outcome).resolves.toMatchObject({ failed: true, message: expect.stringContaining("did not start") });
  });
});
