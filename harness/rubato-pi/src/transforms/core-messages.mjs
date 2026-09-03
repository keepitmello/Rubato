import { replaceOnce } from "./core-replace.mjs";

export function messagesHrefs() {
  return {
    remapHiddenCustom: new URL("./remap-hidden-custom-turns.mjs", import.meta.url).href,
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
 * Remap hidden custom turns to assistant and keep the latest user message last
 * so a memory notice or post-compact restoration cannot steal the user turn.
 */
export function injectMessages(source, hrefs = messagesHrefs()) {
  const remapHref = hrefs.remapHiddenCustom ?? messagesHrefs().remapHiddenCustom;
  let next = replaceOnce(
    source,
    IMPORT_NEEDLE,
    `${IMPORT_NEEDLE}import { remapHiddenCustomTurns } from ${JSON.stringify(remapHref)};\n`,
    "messages remap import",
  );
  next = replaceOnce(
    next,
    RETURN_NEEDLE,
    "    // Continuations are append-only here too: the transport array must extend the\n" +
      "    // previous request verbatim to keep the provider's cache prefix valid.\n" +
      "    return remapHiddenCustomTurns(messages, (m) => {\n",
    "messages remap convertToLlm",
  );
  return replaceOnce(next, FILTER_NEEDLE, "    });\n", "messages remap convertToLlm close");
}
