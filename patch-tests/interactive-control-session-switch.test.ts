import { expect, test } from "bun:test";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const root = VENDOR_PATCHES[0].resolveRoot();
const { InteractiveMode } = await import(`${root}/dist/modes/interactive/interactive-mode.js`);

test("stable facade dereferences the current session after replacement", async () => {
  const calls: string[] = [];
  const first = { abort: async () => { calls.push("first"); } };
  const second = { abort: async () => { calls.push("second"); } };
  const host: any = {
    session: first,
    listInteractiveCommands: () => [],
    dispatchInteractiveInput: async () => undefined,
  };
  const facade = InteractiveMode.prototype.createInteractiveControlSurface.call(host);
  await facade.abortAgent();
  host.session = second;
  await facade.abortAgent();
  expect(calls).toEqual(["first", "second"]);
});
