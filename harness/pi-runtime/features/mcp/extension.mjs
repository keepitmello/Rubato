import { createMcpService } from "./service.mjs";

/**
 * Stock Pi ExtensionFactory. The factory itself only installs lifecycle hooks;
 * the stdio processes are session-owned and start on session_start.
 */
export function createMcpExtension(options) {
  return function rubatoMcpExtension(pi) {
    let service;

    pi.on("session_start", async () => {
      const ownedService = service ?? createMcpService(options);
      service = ownedService;
      const tools = await ownedService.start();
      if (service !== ownedService) {
        await ownedService.close();
        return;
      }
      for (const tool of tools) pi.registerTool(tool);
    });

    pi.on("session_shutdown", async () => {
      const ownedService = service;
      service = undefined;
      await ownedService?.close();
    });
  };
}
