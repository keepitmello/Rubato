import { expect, it, vi } from "vite-plus/test";
import { createPushSyncQueue } from "./syncQueue";

it("a send updates only the card; a foreground refresh covers card requests during registration", async () => {
  const wait = Promise.withResolvers<void>();
  const register = vi.fn(() => wait.promise);
  const card = vi.fn(async () => {});
  const sync = createPushSyncQueue(register, card);
  await sync("card");
  await sync("card");
  expect(register).not.toHaveBeenCalled();
  expect(card).toHaveBeenCalledTimes(2);
  const foreground = sync("full");
  void sync("card");
  void sync("card");
  wait.resolve();
  await foreground;
  expect(register).toHaveBeenCalledTimes(1);
  expect(card).toHaveBeenCalledTimes(3);
});

it("a token change while a card is updating is not lost and the jobs never overlap", async () => {
  const wait = Promise.withResolvers<void>();
  const order: string[] = [];
  const sync = createPushSyncQueue(async () => { order.push("register"); }, async () => {
    order.push("card");
    await wait.promise;
  });
  const sending = sync("card");
  void sync("full");
  void sync("full");
  void sync("card");
  expect(order).toEqual(["card"]);
  wait.resolve();
  await sending;
  expect(order).toEqual(["card", "register", "card"]);
});
