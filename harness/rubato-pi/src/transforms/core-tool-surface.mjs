import { replaceOnce } from "./core-replace.mjs";

export function injectToolSurface(source) {
  const href = new URL("../tool-surface-policy.mjs", import.meta.url).href;
  let next = replaceOnce(source,
    'import { randomUUID } from "node:crypto";',
    `import { randomUUID } from "node:crypto";\nimport { withToolExposure, withoutLegacyEditors } from ${JSON.stringify(href)};`,
    "tool surface policy import");
  next = replaceOnce(next,
    "        const registeredTools = this._extensionRunner.getAllRegisteredTools();",
    `        const registeredTools = this._extensionRunner.getAllRegisteredTools().map((tool) => ({
            ...tool, definition: withToolExposure(tool.definition),
        }));`,
    "registered tool search exposure");
  next = replaceOnce(next,
    "this._baseToolDefinitions = new Map(Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool]));",
    "this._baseToolDefinitions = new Map(Object.entries(baseToolDefinitions).map(([name, tool]) => [name, this._baseToolsOverride ? tool : withToolExposure(tool)]));",
    "base tool search exposure");
  next = replaceOnce(next,
    ': ["read", "bash", "edit", "write"];',
    ': ["read", "bash"];',
    "minimal base tools");
  return replaceOnce(next,
    "    setActiveToolsByName(toolNames) {\n        const tools = [];",
    `    setActiveToolsByName(toolNames) {
        // Keep native exec-bridge editors registered, but expose one editor to models.
        // Explicit SDK base-tool overrides retain their own editing surface.
        if (!this._baseToolsOverride) toolNames = withoutLegacyEditors(toolNames);
        const tools = [];`,
    "single model-facing editor");
}

export function isApplyPatchExtensionUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/gpt-apply-patch/extension.js");
}

export function injectUniversalApplyPatch(source) {
  let next = replaceOnce(source,
    '    if (!isGptId(model))\n        return "none";\n',
    "",
    "apply patch all model families");
  next = replaceOnce(next,
    '    if (APPLY_PATCH_FREEFORM_APIS.has(model.api))',
    '    if (isGptId(model) && APPLY_PATCH_FREEFORM_APIS.has(model?.api))',
    "apply patch freeform only for supported GPT models");
  next = replaceOnce(next,
    '    if (APPLY_PATCH_JSON_APIS.has(model.api))\n        return "json";\n    return "none";',
    '    return "json";',
    "apply patch generic JSON transport");
  return replaceOnce(next,
    '    state.activeVariant = "freeform";\n    pi.registerTool(variants.freeform);',
    '    state.activeVariant = "json";\n    pi.registerTool(variants.json);',
    "apply patch safe initial variant");
}

export function isMcpTierBUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/mcp/expose/tier-b.js");
}

export function isToolSearchServiceUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/tool-search/service.js");
}

export function injectMcpCatalogOwnership(source) {
  return replaceOnce(source,
    '.filter((tool) => tool.exposure === "search" && tool.allowLazyActivation)',
    `.filter((tool) => tool.exposure === "search" && tool.allowLazyActivation
                && tool.sourceInfo?.path !== "<builtin:mcp>")`,
    "MCP feeder is the only catalog owner");
}

export function injectMcpSearchExposure(source) {
  let next = replaceOnce(source,
    "export function registerMcpTierBTools(pi, input, toolSearchService, warn) {",
    `export function registerMcpTierBTools(pi, input, toolSearchService, warn) {
    // Keep server filtering and execution intact; do not advertise eager tools or stubs.
    input = { ...input, searchMode: true, settings: { ...input.settings, stubSwap: false } };
    const previouslyActive = pi.getActiveTools();`,
    "MCP search-only exposure");
  next = replaceOnce(next,
    `    const gatewayNames = [];
    for (const gateway of input.proxyGateways ?? []) {
        const tool = createMcpProxyTool(gateway.server, gateway.entries);
        pi.registerTool(tool);
        gatewayNames.push(tool.name);
    }
    for (const tool of input.utilityTools ?? []) {
        pi.registerTool(tool);
        gatewayNames.push(tool.name);
    }`,
    `    const gatewayTools = [
        ...(input.proxyGateways ?? []).map((gateway) => createMcpProxyTool(gateway.server, gateway.entries)),
        ...(input.utilityTools ?? []),
    ];
    const gatewayNames = gatewayTools.map((tool) => tool.name);
    for (const tool of gatewayTools) {
        pi.registerTool(tool);
        documents.push({
            name: tool.name, label: tool.label ?? tool.name, description: tool.description,
            aliases: [], keywords: [], source: "mcp", group: "mcp", ownerLabel: "mcp",
            registrationId: deriveMcpRegistrationId("<gateway>", tool.name),
        });
    }`,
    "MCP feeder also owns gateway and resource discovery");
  next = replaceOnce(next,
    "    const activeMcpNames = [...mapMcpCatalogNames(input.activeEntries).map(({ name }) => name), ...gatewayNames];",
    `    const activeMcpNames = previouslyActive.filter((name) =>
        fullByName.has(name) || gatewayNames.includes(name));`,
    "MCP retain only previously discovered tools");
  return replaceOnce(next,
    "    const registeredNames = new Set(fullDefs.map((def) => def.name));",
    "    const registeredNames = new Set([...fullDefs.map((def) => def.name), ...gatewayNames]);",
    "MCP gateway activation admission");
}

export function isModelGatedMediaUrl(url) {
  return ["/video-in/index.js", "/look-at/index.js"].some((suffix) =>
    url.endsWith(`/dist/core/extensions/builtin${suffix}`));
}

export function injectDeferredMediaTool(source) {
  let next = replaceOnce(source, "    pi.registerTool({", "    const toolDefinition = {",
    "media definition retained for admission updates");
  next = replaceOnce(next,
    "    });\n    function syncToolActivation",
    '    };\n    pi.registerTool({ ...toolDefinition, exposure: "search", allowLazyActivation: false });\n    function syncToolActivation',
    "media starts undiscoverable until model admission");
  return replaceOnce(next,
    `        if (shouldBeActive && !isActive) {
            pi.setActiveTools([...active, TOOL_NAME]);
        }
        else if (!shouldBeActive && isActive) {`,
    `        pi.registerTool({ ...toolDefinition, exposure: "search", allowLazyActivation: shouldBeActive });
        if (!shouldBeActive && isActive) {`,
    "media admission without eager activation");
}
