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

export function isMcpNamingUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/mcp/expose/naming.js");
}

export function isMcpProxyUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/mcp/expose/proxy.js");
}

/**
 * MCP 도구 이름을 Claude Code 규약(`mcp__…`)으로 맞춘다.
 *
 * Anthropic OAuth wire 는 도구 이름이 `mcp_` 로 시작하되 `mcp__` 가 아니면 그 요청을
 * "Claude Code 가 아닌 third-party 앱"으로 판정하고, 추가 사용량이 꺼진 계정에서는
 * 요청 전체를 400 으로 거절한다(`Third-party apps now draw from your extra usage`).
 * 정품 CLI 는 MCP 도구를 `mcp__<server>__<tool>` 로 등록하므로 홑밑줄 접두는 그 자체가
 * 신원 불일치다. 그래서 이름을 만드는 지점 하나에서 접두만 두 번째 밑줄로 올린다.
 *
 * 접두를 올린 뒤 `^mcp___+` 를 접는 이유는 **기존 이름을 그대로 두기 위해서**다.
 * serverName 이 빈 문자열인 등록(예: `mcp__ast_grep_search`)은 이미 밑줄 두 개로
 * 시작하고, 이 정규화가 없으면 밑줄 세 개짜리 새 이름이 되어 프롬프트·스킬 문서가
 * 가리키던 이름과 어긋난다. 충돌 판정(`matcherKey`)은 이 함수의 결과 위에서 돌므로
 * 접두 변경이 충돌 처리에 구멍을 내지 않는다.
 */
export function injectMcpToolNamePrefix(source) {
  return replaceOnce(source,
    "    return `mcp_${sanitizeNamePart(entry.serverName)}_${sanitizeNamePart(entry.toolName)}`;",
    '    return `mcp__${sanitizeNamePart(entry.serverName)}_${sanitizeNamePart(entry.toolName)}`.replace(/^mcp___+/, "mcp__");',
    "mcp tool name claude-code prefix");
}

/**
 * proxy(Tier-C) gateway 이름도 같은 규약으로 짓는다.
 *
 * 원본은 첫 도구 이름의 앞 두 토큰을 잘라 썼다(`mcp_<server>`). 접두가 `mcp__` 로
 * 바뀌면 그 자르기는 `mcp_` 만 남기고, 그것은 다시 홑밑줄 접두라 위 판정에 그대로
 * 걸린다. server 이름에서 직접 만들면 자르기 규칙과 접두 규약이 한 곳에서 맞는다.
 */
export function injectMcpProxyToolName(source) {
  return replaceOnce(source,
    '    const name = named[0]?.name.split("_").slice(0, 2).join("_") ?? `mcp_${server}`;',
    '    const name = `mcp__${String(server).replace(/[^a-zA-Z0-9_-]/g, "_")}`;',
    "mcp proxy gateway name prefix");
}

export function isToolSearchServiceUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/tool-search/service.js");
}

export function isToolSearchToolUrl(url) {
  return url.endsWith("/dist/core/extensions/builtin/tool-search/tool.js");
}

// Runtime already puts activated tools on the next model request in this user turn
// (`prepareNextTurn` re-reads agent.state.tools). The stock copy said "NEXT turn"
// and models stopped instead of calling them.
export function injectToolSearchSameTurnCopy(source) {
  let next = replaceOnce(source,
    "matched tools are activated and become callable on your NEXT turn.",
    "matched tools are activated and are callable immediately after this result.",
    "tool-search description same-turn");
  next = replaceOnce(next,
    "Search available tool catalogs by capability; matched tools activate next turn.",
    "Search available tool catalogs by capability; matched tools activate immediately.",
    "tool-search snippet same-turn");
  return replaceOnce(next,
    "Matched tools are now active and callable from your NEXT turn:",
    "Matched tools are now active. Call them in this turn:",
    "tool-search result same-turn");
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
