import { createMcpService } from "./service.mjs";

/**
 * Stock Pi ExtensionFactory. The factory itself only installs lifecycle hooks;
 * the stdio processes are session-owned and start on session_start.
 */
export function createMcpExtension(options) {
  return function rubatoMcpExtension(pi) {
    let service;
    const search = options?.toolSearchService;

    pi.on("session_start", async (_event, ctx) => {
      const ownedService = service ?? createMcpService(options);
      service = ownedService;
      const tools = await ownedService.start();
      if (service !== ownedService) {
        await ownedService.close();
        return;
      }
      const activeBeforeRegistration = pi.getActiveTools();
      for (const tool of tools) {
        pi.registerTool(search ? {
          ...tool,
          // MCP owns this catalog entry through search.feed(). Keeping the
          // registered definition out of the generic extension feed prevents
          // duplicate names with conflicting registration identities.
          allowLazyActivation: true,
        } : tool);
      }
      if (search) {
        // Dynamic registration makes stock Pi activate new tools by default.
        // Restore the pre-registration set before the catalog owner adds only
        // tool_search (and any ownership-valid history activations).
        pi.setActiveTools(activeBeforeRegistration);
        const knownNames = new Set(tools.map(({ name }) => name));
        search.feed("mcp", tools.map((tool) => ({
          name: tool.name,
          label: tool.label,
          aliases: [],
          description: tool.description,
          searchText: `${tool.mcpServerName} ${tool.mcpToolName}`,
          keywords: [tool.mcpServerName, tool.mcpToolName, tool.label],
          source: "mcp",
          group: tool.mcpServerName,
          ownerLabel: tool.mcpServerName,
          registrationId: `mcp\0${tool.mcpServerName}\0${tool.mcpToolName}`,
          allowLazyActivation: true,
        })), {
          activate(names) {
            const current = pi.getActiveTools();
            const active = new Set(current);
            const added = names.filter((name) => knownNames.has(name) && !active.has(name));
            if (added.length > 0) pi.setActiveTools([...current, ...new Set(added)]);
          },
        });
        search.maybeRehydrateFromHistory(ctx.sessionManager.getEntries());
      }
    });

    pi.on("session_shutdown", async () => {
      const ownedService = service;
      service = undefined;
      search?.clearFeed("mcp");
      await ownedService?.close();
    });
  };
}
