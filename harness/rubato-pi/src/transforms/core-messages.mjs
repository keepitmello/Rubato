import { replaceOnce } from "./core-replace.mjs";

export function messagesHrefs() {
  return {
    foldHiddenCustom: new URL("./fold-hidden-custom-user-turns.mjs", import.meta.url).href,
  };
}

export function isMessagesUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/messages.js");
}

const IMPORT_NEEDLE = "import { copyContextProvenance } from \"@earendil-works/pi-ai\";\n";
const RETURN_NEEDLE =
  "    // Continuations are append-only here too: the transport array must extend the\n" +
  "    // previous request verbatim to keep the provider's cache prefix valid.\n" +
  "    return messages\n" +
  "        .map((m) => {\n";
const FILTER_NEEDLE = "    })\n        .filter((m) => m !== undefined);\n";

/**
 * Fold hidden custom user-turns into the preceding real user message so a
 * memory notice or post-compact restoration cannot become the latest user turn.
 */
export function injectMessages(source, hrefs = messagesHrefs()) {
  const foldHref = hrefs.foldHiddenCustom ?? messagesHrefs().foldHiddenCustom;
  let next = replaceOnce(
    source,
    IMPORT_NEEDLE,
    `${IMPORT_NEEDLE}import { foldHiddenCustomUserTurns } from ${JSON.stringify(foldHref)};\n`,
    "messages fold import",
  );
  next = replaceOnce(
    next,
    RETURN_NEEDLE,
    "    // Continuations are append-only here too: the transport array must extend the\n" +
      "    // previous request verbatim to keep the provider's cache prefix valid.\n" +
      "    return foldHiddenCustomUserTurns(messages, (m) => {\n",
    "messages fold convertToLlm",
  );
  return replaceOnce(next, FILTER_NEEDLE, "    });\n", "messages fold convertToLlm close");
}
