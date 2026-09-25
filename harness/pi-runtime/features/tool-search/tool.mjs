import { emitActivationMarker } from "./marker.mjs";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

const PARAMETERS = Object.freeze({
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Natural-language description of the capability you need." },
    source: { type: "string", enum: ["mcp", "extension"], description: "Optional catalog source." },
    group: { type: "string", description: "Optional catalog group." },
  },
});

export function createToolSearchTool(service) {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    label: "Tool search",
    // Fixed text on purpose: this definition sits in the cached prefix, so it must not
    // list the catalog, which grows as servers attach.
    description: "Search available tool catalogs by capability and activate matching tools. Most tools start inactive to keep the prompt small: when an instruction, skill or message names a tool you do not have, search for that name before calling it.",
    promptSnippet: "Search available tool catalogs by capability; matched tools activate for the next model turn.",
    parameters: PARAMETERS,
    executionMode: "parallel",
    prepareArguments(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args;
      const { server, ...rest } = args;
      return {
        ...rest,
        ...(rest.source === undefined && server !== undefined ? { source: "mcp" } : {}),
        ...(rest.group === undefined && server !== undefined ? { group: server } : {}),
      };
    },
    async execute(_toolCallId, params) {
      const options = {
        ...(params.source === undefined ? {} : { source: params.source }),
        ...(params.group === undefined ? {} : { group: params.group }),
      };
      const matches = service.search(params.query, 10, options);
      const activated = service.activate(matches);
      return {
        content: [{ type: "text", text: buildToolSearchResultText(params.query, matches, params.source, params.group) }],
        details: { activated, query: params.query },
      };
    },
  };
}

export function buildToolSearchResultText(query, matches, source, group) {
  const scope = [source && `source "${source}"`, group && `group "${group}"`].filter(Boolean).join(" in ");
  const scopeText = scope ? ` in ${scope}` : "";
  if (matches.length === 0) {
    return `No tools matched "${query}"${scopeText}. No tools were activated; try broader keywords.`;
  }
  const bullets = matches.map((match) => `- ${match.name} — ${oneLine(match.doc.description)}`).join("\n");
  const marker = emitActivationMarker(matches.map((match) => ({
    name: match.name,
    registrationId: match.doc.registrationId,
  })));
  return [
    `Found ${matches.length} tool(s) matching "${query}"${scopeText}. They are active for the next model turn and callable immediately through executeTool:`,
    "",
    bullets,
    "",
    marker,
  ].join("\n");
}

function oneLine(text) {
  const collapsed = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!collapsed) return "(no description)";
  return collapsed.length <= 100 ? collapsed : `${collapsed.slice(0, 97)}...`;
}
