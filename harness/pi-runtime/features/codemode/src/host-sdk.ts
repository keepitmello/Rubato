import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keeping host imports here prevents the vendored codemode source from acquiring a
// runtime dependency or fallback on @code-yeongyu/senpi.
export * from "@earendil-works/pi-coding-agent";

// pi-ai is selected from coding-agent's own dependency edge rather than from a
// top-level/global fallback. The codemode feature itself stays at the runtime root.
// Resolving from the coding-agent entry finds its nested copy (0.86.1 layout) or the hoisted
// sibling (1.0.1 layout) exactly as the coding agent itself does.
const codingAgentEntry = pathToFileURL(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piAiDir = dirname(findPackageJSON("@earendil-works/pi-ai", codingAgentEntry) as string);
const piAiCompatEntry = join(piAiDir, "dist/compat.js");
const piAiCompat = await import(pathToFileURL(piAiCompatEntry).href);

export const completeSimple: typeof piAiCompat.completeSimple = piAiCompat.completeSimple;

// This Senpi TUI helper does not exist in stock pi-tui 0.85.1. Preserve its
// exact small MIT implementation here instead of depending on Senpi at runtime.
const TERMINAL_ESCAPE_PATTERN =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function sanitizeTerminalLabel(value: string): string {
	return value
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
