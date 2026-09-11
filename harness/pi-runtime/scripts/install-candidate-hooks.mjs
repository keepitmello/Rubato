import { appendFileSync } from "node:fs";

let report;

export function initialize(data) {
  report = data?.report;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (report && result?.url) {
    try { appendFileSync(report, `${result.url}\n`); } catch { /* report is best-effort */ }
  }
  return result;
}
