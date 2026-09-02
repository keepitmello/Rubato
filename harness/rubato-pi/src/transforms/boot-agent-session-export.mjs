import { replaceOnce } from "./replace-once.mjs";

export function isBootAgentSessionUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/agent-session.js");
}

/** /export HTML 은 첫 페인트에 필요 없다. agent-session 정적 그래프에서 뺀다. */
export function injectAgentSessionDeferExportHtml(source) {
  let next = source;
  next = replaceOnce(
    next,
    'import { exportSessionToHtml } from "./export-html/index.js";\nimport { createToolHtmlRenderer } from "./export-html/tool-renderer.js";\n',
    "",
    "agent-session defer export-html imports",
  );
  next = replaceOnce(
    next,
    "        const toolRenderer = createToolHtmlRenderer({\n            getToolDefinition: (name) => this.getToolDefinition(name),\n            theme,\n            cwd: this.sessionManager.getCwd(),\n        });\n        return await exportSessionToHtml(this.sessionManager, this.state, {\n            outputPath,\n            themeName,\n            toolRenderer,\n        });\n",
    `        const { createToolHtmlRenderer } = await import("./export-html/tool-renderer.js");
        const { exportSessionToHtml } = await import("./export-html/index.js");
        const toolRenderer = createToolHtmlRenderer({
            getToolDefinition: (name) => this.getToolDefinition(name),
            theme,
            cwd: this.sessionManager.getCwd(),
        });
        return await exportSessionToHtml(this.sessionManager, this.state, {
            outputPath,
            themeName,
            toolRenderer,
        });
`,
    "agent-session defer export-html call",
  );
  return next;
}
