// Senpi-origin bash timeout policy; MIT attribution: ./THIRD_PARTY_NOTICES.md

export const BASH_DEFAULT_TIMEOUT_SECONDS = 1800;
export const BASH_MAX_TIMEOUT_SECONDS = 1800;

function positiveInt(value) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveBashTimeoutDefaults(env = {}) {
  const defaultSeconds = positiveInt(env.PI_BASH_DEFAULT_TIMEOUT_SECONDS) ?? BASH_DEFAULT_TIMEOUT_SECONDS;
  const rawMax = positiveInt(env.PI_BASH_MAX_TIMEOUT_SECONDS) ?? BASH_MAX_TIMEOUT_SECONDS;
  return { defaultSeconds, maxSeconds: Math.max(rawMax, defaultSeconds) };
}

export function applyBashTimeout(input, defaults) {
  return input.timeout === undefined || input.timeout <= 0
    ? { ...input, timeout: defaults.defaultSeconds }
    : input;
}

export function buildBashTimeoutPrompt(defaults, { foregroundWindowSeconds } = {}) {
  const minutes = (seconds) => seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
  const detach = foregroundWindowSeconds === undefined ? "" : `\n- Foreground blocking stops at the ~${foregroundWindowSeconds}s window. A command still running then auto-detaches alive to a background session with a \`bash_id\` and keeps running until it exits or hits the kill deadline; the session tools in the terminal section steer or stop it.`;
  return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool's \`timeout\` parameter is the process kill deadline, not how long you wait for output: the command is killed when it reaches the deadline.\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Recommended maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}). Explicit \`timeout\` values are preserved because different hosts may use different timeout units.${detach}`;
}

export function createBashTimeoutExtension(options = {}) {
  return function bashTimeoutExtension(pi) {
    const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
    const defaults = resolveBashTimeoutDefaults(env);
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const updated = applyBashTimeout(event.input, defaults);
      if (updated !== event.input) event.input.timeout = updated.timeout;
      return undefined;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const nativeAnthropic = options.isAnthropicBashEnabled?.(ctx) === true && ctx.model?.api === "anthropic-messages";
      const foregroundWindowSeconds = nativeAnthropic
        ? undefined
        : options.resolveForegroundWindowSeconds?.(ctx);
      return {
        systemPrompt: `${event.systemPrompt}${buildBashTimeoutPrompt(defaults,
          foregroundWindowSeconds === undefined ? {} : { foregroundWindowSeconds })}`,
      };
    });
  };
}

export const bashTimeoutExtension = createBashTimeoutExtension();
