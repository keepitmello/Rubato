import { replaceOnce } from "./core-replace.mjs";

const NEEDLE =
  "    const liveContextTokens = hasExistingSession\n" +
  "        ? existingSession.messages.reduce((total, message) => total + estimateTokens(message), 0)\n" +
  "        : 0;\n" +
  "    session.assertModelUsable(undefined, liveContextTokens);";

const REPLACEMENT =
  "    const liveContextTokens = hasExistingSession\n" +
  "        ? existingSession.messages.reduce((total, message) => total + estimateTokens(message), 0)\n" +
  "        : 0;\n" +
  "    try {\n" +
  "        session.assertModelUsable(undefined, liveContextTokens);\n" +
  "    }\n" +
  "    catch (error) {\n" +
  "        if (!hasExistingSession || liveContextTokens <= 0)\n" +
  "            throw error;\n" +
  "        // A large history is recoverable through /compact. Only reject models\n" +
  "        // whose fixed prompt, tools, and reserves cannot fit even an empty turn.\n" +
  "        session.assertModelUsable(undefined, 0);\n" +
  "        const recoveryMessage = \"Session history exceeds this model's safe context budget. Opened in recovery mode; run /compact before sending or switching models.\";\n" +
  "        modelFallbackMessage = modelFallbackMessage ? `${modelFallbackMessage}. ${recoveryMessage}` : recoveryMessage;\n" +
  "    }";

export function isSdkUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/sdk.js");
}

/** Let an oversized persisted session open far enough for manual compaction. */
export function injectResumeRecovery(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "oversized session resume recovery");
}
