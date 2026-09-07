import type { ExtensionAPI } from "../host-sdk.ts";

export function isAnthropicBashEnabled(): boolean {
	const value = process.env.PI_ANTHROPIC_BASH;
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isEvalOnlyRouting(pi: ExtensionAPI): boolean {
	if (typeof pi.getAllTools !== "function") return false;
	return pi.getAllTools().some((tool) => tool.name === "eval");
}
