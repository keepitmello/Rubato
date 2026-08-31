import { replaceOnce } from "./core-replace.mjs";

export function isStreamWatchdogUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/compaction/stream-watchdog.js");
}

/** Series #3: summarization max duration 600s. .d.ts hunk skipped (types never load). */
export function injectStreamWatchdog(source) {
  return replaceOnce(
    source,
    "export const DEFAULT_SUMMARIZATION_MAX_DURATION_MS = 120_000;",
    "export const DEFAULT_SUMMARIZATION_MAX_DURATION_MS = 600_000;",
    "summarization max duration",
  );
}
