import { replaceOnce } from "./core-replace.mjs";

export function isEvalOnlyRoutingUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/eval-only-routing.js");
}

export function isTerminalPromptUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/terminal/prompt.js");
}

export function isTerminalExtensionUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/terminal/extension.js");
}

export function injectEvalOnlyRouting(source) {
  let next = replaceOnce(source,
    "export function isEvalOnlyRouting(pi) {",
    'export function isEvalOnlyRouting(pi, toolName = "bash") {',
    "eval routing tool name");
  next = replaceOnce(next,
    '    if (typeof pi.getAllTools !== "function")',
    '    if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function")',
    "eval routing active-tools API");
  return replaceOnce(next,
    '    return pi.getAllTools().some((tool) => tool.name === "eval");',
    `    const tools = pi.getAllTools();
    return tools.some((tool) => tool.name === "eval")
        && tools.some((tool) => tool.name === toolName)
        && !pi.getActiveTools().includes(toolName);`,
    "eval routing actual exposure");
}

export function injectTerminalPrompt(source) {
  let next = replaceOnce(source,
    '    const bash = options.evalOnly ? "tool.bash" : "bash";',
    '    const bash = (options.bashEvalOnly ?? options.evalOnly) ? "tool.bash" : "bash";',
    "terminal bash routing");
  return replaceOnce(next,
    '    const monitor = options.evalOnly ? "tool.monitor" : "monitor";',
    '    const monitor = (options.monitorEvalOnly ?? options.evalOnly) ? "tool.monitor" : "monitor";',
    "terminal monitor routing");
}

export function injectTerminalExtension(source) {
  return replaceOnce(source,
    "buildTerminalPromptSection({ evalOnly: isEvalOnlyRouting(pi) })",
    'buildTerminalPromptSection({ bashEvalOnly: isEvalOnlyRouting(pi, "bash"), monitorEvalOnly: isEvalOnlyRouting(pi, "monitor") })',
    "terminal per-tool prompt routing");
}
