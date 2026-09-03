import { replaceOnce } from "./core-replace.mjs";

// senpi SessionManager waits to create the jsonl until the first assistant
// message is persisted. The first user turn can run tools for minutes before
// that happens. A crash, disconnect, or provider error in that window leaves
// only an artifacts/ directory — resume has nothing to open, so the session
// disappears from the picker (2026-09-03 01a067bb-fb95, 01a067c1).
//
// Flush as soon as a user or assistant message exists. Opening the TUI and
// quitting still creates no file.

const NEEDLE =
  "        const persistedEntry = this.residentStore.materialize(entry);\n" +
  "        const hasAssistant = this.fileEntries.some((e) => e.type === \"message\" && e.message.role === \"assistant\");\n" +
  "        if (!hasAssistant) {\n" +
  "            if (this.flushed) {\n" +
  "                appendFileSync(this.sessionFile, `${JSON.stringify(persistedEntry)}\\n`);\n" +
  "            }\n" +
  "            else {\n" +
  "                // Mark as not flushed so when assistant arrives, all entries get written\n" +
  "                this.flushed = false;\n" +
  "            }\n" +
  "            return;\n" +
  "        }";

const REPLACEMENT =
  "        const persistedEntry = this.residentStore.materialize(entry);\n" +
  "        const hasMessage = this.fileEntries.some((e) => e.type === \"message\" && (e.message.role === \"assistant\" || e.message.role === \"user\"));\n" +
  "        if (!hasMessage) {\n" +
  "            if (this.flushed) {\n" +
  "                appendFileSync(this.sessionFile, `${JSON.stringify(persistedEntry)}\\n`);\n" +
  "            }\n" +
  "            else {\n" +
  "                this.flushed = false;\n" +
  "            }\n" +
  "            return;\n" +
  "        }";

export function isSessionManagerUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/session-manager.js");
}

/** Persist the jsonl on the first user message, not the first assistant reply. */
export function injectSessionPersist(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "session persist on first user message");
}
