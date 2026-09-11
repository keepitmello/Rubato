import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export * from "@earendil-works/pi-coding-agent";

// Follow coding-agent's validated dependency edges. The runtime resolver rejects
// mixed identities before this feature loads, and there is no global/Senpi fallback.
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDir = dirname(dirname(codingAgentEntry));
const piAi = await import(
	pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
);
const piTui = await import(
	pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href
);

export const StringEnum: typeof piAi.StringEnum = piAi.StringEnum;
export const Text: typeof piTui.Text = piTui.Text;
