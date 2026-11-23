import { afterEach, expect, it, vi } from "vite-plus/test";
import { startRoomPoll } from "./roomPoll";

afterEach(() => vi.useRealTimers());

it("does not overlap slow requests or wake up again after leaving mid-request", async () => {
  vi.useFakeTimers();
  const request = Promise.withResolvers<void>();
  const ask = vi.fn((_signal: AbortSignal) => request.promise);
  const stop = startRoomPoll(100, ask);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ask).toHaveBeenCalledTimes(1);
  stop();
  expect(ask.mock.calls[0]![0].aborted).toBe(true);
  request.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ask).toHaveBeenCalledTimes(1);
});

it("retries a dropped connection and stops on a finished record", async () => {
  vi.useFakeTimers();
  const ask = vi.fn<() => Promise<void | false>>().mockRejectedValueOnce(Error("offline")).mockResolvedValue(false);
  const stop = startRoomPoll(100, ask);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ask).toHaveBeenCalledTimes(2);
  stop();
});
