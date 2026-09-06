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
        && tools.find((tool) => tool.name === toolName)?.exposure !== "search"
        && !pi.getActiveTools().includes(toolName);`,
    "eval routing actual exposure");
}

export function injectTerminalPrompt(source) {
  let next = replaceOnce(source,
    '    const bash = options.evalOnly ? "tool.bash" : "bash";',
    '    const bash = (options.bashEvalOnly ?? options.evalOnly) ? "tool.bash" : "bash";',
    "terminal bash routing");
  next = replaceOnce(next,
    '    const monitor = options.evalOnly ? "tool.monitor" : "monitor";',
    '    const monitor = (options.monitorEvalOnly ?? options.evalOnly) ? "tool.monitor" : "monitor";',
    "terminal monitor routing");
  const body = next.match(/    return `[\s\S]*?`;\n}/)?.[0];
  if (!body) throw new Error("rubato terminal prompt body drift");
  return replaceOnce(next, body, `    return \`
## Persistent terminal sessions

Use \\\`\${bash}({ command, run_in_background: true })\\\` for long-lived or interactive work,
not tmux or shell backgrounding. Foreground commands may also detach after ~60s.
The timeout is a process kill deadline, not the foreground wait.
Completion is delivered automatically; do not poll or sleep to wait.
Use tool_search to load terminal control tools when needed: bash_output for a peek,
bash_input to steer, bash_resize to resize, kill_bash to stop your session tree.
For observable state, discover \\\`\${monitor}\\\` and subscribe instead of polling.
\`;
}`, "compact terminal prompt");
}

export function injectTerminalExtension(source) {
  let next = replaceOnce(source,
    "buildTerminalPromptSection({ evalOnly: isEvalOnlyRouting(pi) })",
    'buildTerminalPromptSection({ bashEvalOnly: isEvalOnlyRouting(pi, "bash"), monitorEvalOnly: isEvalOnlyRouting(pi, "monitor") })',
    "terminal per-tool prompt routing");
  next = replaceOnce(next,
    "    if (stepAside) {\n        for (const companion of TERMINAL_COMPANION_TOOLS)\n            active.add(companion);",
    "    if (stepAside) {\n        // Companions remain discoverable rather than eagerly activated.",
    "native terminal lazy companions");
  return replaceOnce(next,
    "        active.add(TERMINAL_BASH_TOOL);\n        for (const companion of TERMINAL_COMPANION_TOOLS)\n            active.add(companion);",
    "        active.add(TERMINAL_BASH_TOOL);",
    "terminal lazy companions");
}
