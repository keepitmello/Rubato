import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const report = process.env.RUBATO_ISOLATED_LOAD_REPORT;
if (!report) throw new Error("RUBATO_ISOLATED_LOAD_REPORT must point at a writable report file");

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const record = (url) => {
      if (report && url) {
        try { appendFileSync(report, `${url}\n`); } catch { /* report is best-effort */ }
      }
    };
    if (result && typeof result.then === "function") {
      return result.then((resolved) => { record(resolved?.url); return resolved; });
    }
    record(result?.url);
    return result;
  },
});
