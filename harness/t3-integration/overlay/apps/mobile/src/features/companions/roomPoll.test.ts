import { afterEach, expect, it, vi } from "vite-plus/test";
import { startLiveWorkPoll, startRoomPoll } from "./roomPoll";

afterEach(() => vi.useRealTimers());

it("backs off a steady mark, probes quickly after a change and refreshes on return", async () => {
  vi.useFakeTimers();
  let work: string | null = null;
  const read = vi.fn(async () => work);
  const show = vi.fn();
  const stop = startLiveWorkPoll(read, show);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(17); // 0, 1200, 3600, then every 4 s
  expect(show.mock.calls).toEqual([[null]]);
  work = "file";
  await vi.advanceTimersByTimeAsync(3_600);
  expect(show.mock.calls.at(-1)).toEqual(["file"]);
  const afterChange = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1_200);
  expect(read).toHaveBeenCalledTimes(afterChange + 1);
  stop();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(read).toHaveBeenCalledTimes(afterChange + 1);
  work = "terminal";
  const leave = startLiveWorkPoll(read, show);
  await vi.advanceTimersByTimeAsync(0);
  expect(show.mock.calls.at(-1)).toEqual(["terminal"]);
  leave();
});

it("never paints a stale response after leaving, even if the transport ignored abort", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<string>();
  const show = vi.fn();
  const leave = startLiveWorkPoll(() => pending.promise, show);
  leave();
  pending.resolve("terminal");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(show).not.toHaveBeenCalled();
});

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
