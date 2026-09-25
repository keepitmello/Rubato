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
      // Only tools that declare search exposure are pulled back here. Policy-hidden tools
      // never start active unless something asked for them by name (an agent definition's
      // tool allowlist, a restored transcript), and that request stands.
      const searchable = new Set(
        pi.getAllTools()
          .filter((tool) => (tool.declaredExposure ?? tool.exposure) === "search")
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
