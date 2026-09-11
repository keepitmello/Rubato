import { ToolSearchService } from "./service.mjs";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.mjs";

export function createToolSearchExtension(service = new ToolSearchService()) {
  return function rubatoToolSearchExtension(pi) {
    service.bindRuntime(pi);
    pi.registerLazyToolActivator((name) => service.activateTool(name));
    let toolRegistered = false;
    service.bindToolRegistrar(() => {
      if (toolRegistered) return;
      toolRegistered = true;
      pi.registerTool(createToolSearchTool(service));
    });
    pi.on("session_start", (_event, ctx) => {
      const searchable = new Set(
        pi.getAllTools()
          .filter((tool) => tool.exposure === "search")
          .map((tool) => tool.name),
      );
      pi.setActiveTools(pi.getActiveTools().filter((name) => !searchable.has(name)));
      service.beginSession(ctx.sessionManager.getEntries());
    });
    pi.on("context", (event) => service.maybeRehydrateFromHistory(event.messages));
  };
}

export { ToolSearchService } from "./service.mjs";
export { buildToolSearchResultText, createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.mjs";
export { emitActivationMarker, parseActivationMarkers, rehydrate } from "./marker.mjs";
