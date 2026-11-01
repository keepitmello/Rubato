import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PrimaryEnvironmentRequestError, retryTransientBootstrap } from "./auth";

const request = HttpClientRequest.get("http://localhost:3773/api/auth/session");
const transportFailure = () =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause: new TypeError("Failed to fetch") }),
  });
const wrap = (cause: unknown) =>
  PrimaryEnvironmentRequestError.fromCause({ operation: "fetch-session-state", cause });

describe("primary environment connection recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["fetch-session-state", "exchange-bootstrap-credential", "fetch-environment-descriptor"] as const)(
    "retries the wrapped Failed to fetch during %s",
    async (operation) => {
      const failure = PrimaryEnvironmentRequestError.fromCause({ operation, cause: transportFailure() });
      const run = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue("ready");
      const result = retryTransientBootstrap(run);
      const assertion = expect(result).resolves.toBe("ready");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(run).toHaveBeenCalledTimes(3);
    },
  );

  it("allows a desktop backend to finish its recovery after the old 15 second budget", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    const startedAt = Date.now();
    const run = vi.fn(async () => {
      if (Date.now() - startedAt < 45_000) throw wrap(transportFailure());
      return "ready";
    });
    const assertion = expect(retryTransientBootstrap(run)).resolves.toBe("ready");
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
    expect(run).toHaveBeenCalledTimes(91);
  });

  it.each([{ desktop: false, budget: 15_000 }, { desktop: true, budget: 60_000 }])(
    "stops retrying after $budget ms (desktop=$desktop)",
    async ({ desktop, budget }) => {
      vi.stubGlobal("window", desktop ? { desktopBridge: {} } : {});
      const failure = wrap(transportFailure());
      const run = vi.fn().mockRejectedValue(failure);
      const assertion = expect(retryTransientBootstrap(run)).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(budget);
      await assertion;
      expect(run).toHaveBeenCalledTimes(budget / 500 + 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([400, 401, 403, 404, 500])("does not retry an actual HTTP %s response", async (status) => {
    const response = HttpClientResponse.fromWeb(request, new Response(null, { status }));
    const failure = wrap(new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request, response }),
    }));
    const run = vi.fn().mockRejectedValue(failure);
    await expect(retryTransientBootstrap(run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([HttpClientError.EncodeError, HttpClientError.InvalidUrlError])(
    "does not mistake a request construction error for a disconnected backend",
    async (Reason) => {
      const failure = wrap(new HttpClientError.HttpClientError({
        reason: new Reason({ request, cause: new TypeError("invalid request") }),
      }));
      const run = vi.fn().mockRejectedValue(failure);
      await expect(retryTransientBootstrap(run)).rejects.toBe(failure);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
});
