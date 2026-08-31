import { replaceOnce } from "./core-replace.mjs";

const NEEDLE = "export function sanitizeTuiErrorMessage(value) {\n    return value\n        .replace(/\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|\\u009c|$)/g, \"\")\n        .replace(/(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]/g, \"\")\n        .replace(/\\r\\n?/g, \"\\n\")\n        .replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/g, \"\")\n        .replace(/[ \\t\\f\\v]+/g, \" \");\n}\n";

const REPLACEMENT = "/**\n * Display-only hint for provider stream stalls. Stored `errorMessage` values\n * must keep their anchored shapes so retry classifiers still match; clarify\n * only when painting the TUI.\n */\nexport function clarifyProviderStallError(message) {\n    if (/^Provider stream start timed out after \\d+ms$/i.test(message)) {\n        return `${message}. Upstream sent no first event — often rate-limit or overload; wait and retry, or switch model/provider.`;\n    }\n    if (/^Idle timeout waiting for provider stream after \\d+ms$/i.test(message)) {\n        return `${message}. The stream went silent mid-response — network stall or provider overload.`;\n    }\n    return message;\n}\nexport function sanitizeTuiErrorMessage(value) {\n    return clarifyProviderStallError(value\n        .replace(/\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|\\u009c|$)/g, \"\")\n        .replace(/(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]/g, \"\")\n        .replace(/\\r\\n?/g, \"\\n\")\n        .replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/g, \"\")\n        .replace(/[ \\t\\f\\v]+/g, \" \"));\n}\n";

export function isErrorFormatUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/extension-error-format.js");
}

/** Series #31: clarify provider stall errors when painting the TUI. */
export function injectErrorFormat(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "clarifyProviderStallError");
}
