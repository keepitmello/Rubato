import { replaceOnce } from "./core-replace.mjs";

// Resume of a large session (gpt-6-astra: 272k window, 128k output reserve)
// must open so the user can compact. assertModelUsable here is a model-switch
// gate; on continue it process.exit(1)s the TUI via handleFatalRuntimeError.

const NEEDLE =
  "    const liveContextTokens = hasExistingSession\n" +
  "        ? existingSession.messages.reduce((total, message) => total + estimateTokens(message), 0)\n" +
  "        : 0;\n" +
  "    session.assertModelUsable(undefined, liveContextTokens);\n";

const REPLACEMENT =
  "    if (!hasExistingSession) {\n" +
  "        session.assertModelUsable();\n" +
  "    }\n";

export function isSdkUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/sdk.js");
}

export function injectResumeUsabilityBudget(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "resume skip usability budget assert");
}
