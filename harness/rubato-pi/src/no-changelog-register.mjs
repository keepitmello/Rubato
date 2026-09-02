import { register } from "node:module";

const registered = Symbol.for("rubato.no-changelog-register");
if (!globalThis[registered]) {
  globalThis[registered] = true;
  register(new URL("./no-changelog-hooks.mjs", import.meta.url));
}
