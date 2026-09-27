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
const { RubatoUpdateDot } = await import("../components/settings/RubatoAboutSection");

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
