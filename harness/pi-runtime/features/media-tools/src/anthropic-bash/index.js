const ANTHROPIC_BASH_ENV = "PI_ANTHROPIC_BASH";
const ANTHROPIC_NATIVE_BASH_TOOL = {
	type: "bash_20250124",
	name: "bash",
};

function isRecord(value) {
	return typeof value === "object" && value !== null;
}

function isBashType(value) {
	return typeof value === "string" && value.startsWith("bash_");
}

function sanitizeTools(tools) {
	const sanitizedTools = [];
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		const shouldStripFunctionVariant = tool.name === "bash" && !isBashType(tool.type);
		if (!shouldStripFunctionVariant) sanitizedTools.push(tool);
	}
	return sanitizedTools;
}

export function isAnthropicBashEnabled() {
	const value = process.env[ANTHROPIC_BASH_ENV];
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function addAnthropicBashToPayload(api, payload) {
	if (api !== "anthropic-messages") return payload;
	if (!isAnthropicBashEnabled()) return payload;
	if (!isRecord(payload)) return payload;
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const sanitizedTools = sanitizeTools(tools);
	const hasNativeBash = sanitizedTools.some((tool) => isBashType(tool.type));
	if (!hasNativeBash) sanitizedTools.push(ANTHROPIC_NATIVE_BASH_TOOL);
	return { ...payload, tools: sanitizedTools };
}

function readString(record, key) {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function formatBashResult(raw) {
	if (!isRecord(raw)) return undefined;
	if (raw.type === "server_tool_use") {
		if (raw.name !== "bash") return undefined;
		const command = isRecord(raw.input) ? readString(raw.input, "command") : undefined;
		return command ? `bash: ${command}` : "bash";
	}
	if (raw.type !== "bash_code_execution_tool_result" && raw.type !== "code_execution_tool_result") {
		return undefined;
	}
	const content = raw.content;
	if (typeof content === "string" && content.trim()) return content.trim();
	if (!isRecord(content)) return undefined;
	if (readString(content, "type")?.endsWith("_error")) {
		return `bash error: ${readString(content, "error_code") ?? "unknown"}`;
	}
	const lines = [];
	const stdout = readString(content, "stdout");
	const stderr = readString(content, "stderr");
	const code = content.return_code;
	if (stdout?.trim()) lines.push(stdout.replace(/\n$/, ""));
	if (stderr?.trim()) lines.push(`stderr:\n${stderr.replace(/\n$/, "")}`);
	if (typeof code === "number" && code !== 0) lines.push(`exit ${code}`);
	return lines.length > 0 ? lines.join("\n") : "bash completed";
}

const LANDING_PREFIX = "Native bash result:";

export function materializeAnthropicBash(message) {
	if (!Array.isArray(message.content)) return undefined;
	if (message.content.some((block) => block.type === "text" && block.text.startsWith(LANDING_PREFIX))) {
		return undefined;
	}
	const parts = [];
	for (const block of message.content) {
		if (block.type !== "providerNative") continue;
		const formatted = formatBashResult(block.raw);
		if (formatted) parts.push(formatted);
	}
	if (parts.length === 0) return undefined;
	return {
		...message,
		content: [...message.content, { type: "text", text: `${LANDING_PREFIX}\n${parts.join("\n")}` }],
	};
}

export const ANTHROPIC_BASH_SECTION = `
## Bash Tool

The native bash tool is available in this session. The model has direct
shell access via the bash_20250124 tool. The session is stateless — each
command runs independently. The 'restart' parameter is accepted but has
no effect (no persistent shell session). Standard senpi safety
guardrails still apply.
`;

export default function anthropicBashExtension(pi) {
	pi.on("before_provider_request", (event, ctx) => {
		return addAnthropicBashToPayload(ctx.model?.api, event.payload);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") return undefined;
		if (!isAnthropicBashEnabled()) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${ANTHROPIC_BASH_SECTION}` };
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return undefined;
		const message = materializeAnthropicBash(event.message);
		return message === undefined ? undefined : { message };
	});
}
