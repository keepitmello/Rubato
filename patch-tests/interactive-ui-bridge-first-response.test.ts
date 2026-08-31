import { expect, test } from "bun:test";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const root = VENDOR_PATCHES[0].resolveRoot();
const { InteractiveMode } = await import(`${root}/dist/modes/interactive/interactive-mode.js`);

test("only the first valid standard UI response settles the request", () => {
  const values: unknown[] = [];
  const events: Array<[string, unknown]> = [];
  const host: any = {
    session: { emitExtensionEvent: (name: string, payload: unknown) => events.push([name, payload]) },
  };
  const id = InteractiveMode.prototype.openStandardUiRequest.call(
    host,
    { kind: "select", title: "Pick", options: ["a", "b"] },
    (value: unknown, origin: string) => {
      values.push(value);
      InteractiveMode.prototype.finishStandardUiRequest.call(host, id, origin);
    },
  );
  expect(InteractiveMode.prototype.respondToStandardUiRequest.call(host, id, "missing")).toBe(false);
  expect(InteractiveMode.prototype.respondToStandardUiRequest.call(host, id, "b")).toBe(true);
  expect(InteractiveMode.prototype.respondToStandardUiRequest.call(host, id, "a")).toBe(false);
  expect(values).toEqual(["b"]);
  expect(events.map(([name]) => name)).toEqual(["interactive.ui.request", "interactive.ui.dismiss"]);
});
