import { replaceOnce } from "./core-replace.mjs";

const IMPORT_NEEDLE = "import { formatProviderNativeBody, formatProviderNativeSummary } from \"../../provider-native-rendering.js\";\nimport { theme } from \"../theme/theme.js\";";

const IMPORT_REPLACEMENT = "import { formatProviderNativeBody, formatProviderNativeSummary } from \"../../provider-native-rendering.js\";\nimport { sanitizeTuiErrorMessage } from \"../extension-error-format.js\";\nimport { theme } from \"../theme/theme.js\";";

const ABORT_NEEDLE = "            const abortMessage = message.errorMessage && message.errorMessage !== \"Request was aborted\"\n                ? message.errorMessage\n                : \"Operation aborted\";\n            addError(abortMessage);";

const ABORT_REPLACEMENT = "            const abortMessage = message.errorMessage && message.errorMessage !== \"Request was aborted\"\n                ? message.errorMessage\n                : \"Operation aborted\";\n            addError(sanitizeTuiErrorMessage(abortMessage));";

const ERR_NEEDLE = "                addError(`Error: ${message.errorMessage || \"Unknown error\"}`);";

const ERR_REPLACEMENT = "                addError(`Error: ${sanitizeTuiErrorMessage(message.errorMessage || \"Unknown error\")}`);";

export function isCoreDescriptorsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/assistant-render-descriptors.js");
}

/**
 * Series #31 descriptors hunks. Needles are taken from tui-chrome composed
 * text (injectAssistantDescriptors), not pristine — abort-once already dropped
 * the hasToolCalls guard before we run.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectCoreDescriptors(source) {
  let next = replaceOnce(source, IMPORT_NEEDLE, IMPORT_REPLACEMENT, "descriptors sanitize import");
  next = replaceOnce(next, ABORT_NEEDLE, ABORT_REPLACEMENT, "descriptors sanitize abort");
  return replaceOnce(next, ERR_NEEDLE, ERR_REPLACEMENT, "descriptors sanitize error");
}
