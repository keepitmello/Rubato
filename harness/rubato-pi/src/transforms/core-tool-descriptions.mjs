import { replaceOnce } from "./core-replace.mjs";

const WRAPPER_NEEDLE = "        description: definition.description,\n";
const WRAPPER_REPLACEMENT = "        description: slimToolDescription(definition.name, definition.description),\n";

const IMPORT_NEEDLE = "/** Wrap a ToolDefinition into an AgentTool for the core runtime. */\nexport function wrapToolDefinition";

/**
 * @param {string} [url]
 * @returns {boolean}
 */
export function isToolDefinitionWrapperUrl(url) {
  return typeof url === "string" && url.includes("@code-yeongyu/senpi/dist/core/tools/tool-definition-wrapper.js");
}

/** @returns {{ slim: string }} */
export function toolDescriptionHrefs() {
  return {
    slim: new URL("../tool-description-slim.mjs", import.meta.url).href,
  };
}

/**
 * Rewrite only the AgentTool `description` copy inside wrapToolDefinition.
 * Original ToolDefinition objects, catalog text, schemas, and execute stay intact.
 *
 * @param {string} source
 * @param {{ slim?: string }} [hrefs]
 * @returns {string}
 */
export function injectToolDescriptions(source, hrefs = toolDescriptionHrefs()) {
  const slimHref = hrefs.slim ?? toolDescriptionHrefs().slim;
  let next = replaceOnce(
    source,
    IMPORT_NEEDLE,
    `import { slimToolDescription } from ${JSON.stringify(slimHref)};\n\n${IMPORT_NEEDLE}`,
    "tool-description slim import",
  );
  return replaceOnce(next, WRAPPER_NEEDLE, WRAPPER_REPLACEMENT, "tool-description wrapToolDefinition");
}
