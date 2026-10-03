import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export * from "@earendil-works/pi-coding-agent";

// Follow coding-agent's validated dependency edges. The runtime resolver rejects
// mixed identities before this feature loads, and there is no global/Senpi fallback.
// Resolving from the coding-agent entry finds its nested copy (0.86.1 layout) or the hoisted
// sibling (1.0.1 layout) exactly as the coding agent itself does.
const codingAgentEntry = pathToFileURL(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const packageDirOf = (name: string) => dirname(findPackageJSON(name, codingAgentEntry) as string);
const piAi = await import(pathToFileURL(join(packageDirOf("@earendil-works/pi-ai"), "dist/index.js")).href);
const piTui = await import(pathToFileURL(join(packageDirOf("@earendil-works/pi-tui"), "dist/index.js")).href);

export const StringEnum: typeof piAi.StringEnum = piAi.StringEnum;
export const Text: typeof piTui.Text = piTui.Text;
