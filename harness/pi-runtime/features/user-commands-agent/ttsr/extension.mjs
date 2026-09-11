export const COLLAPSE_RULE_NAME = "collapse-repetition";
export const CONTROL_LEAK_RULE_NAME = "control-token-leak";
export const REPETITIVE_TURNS_RULE_NAME = "repetitive-turns";

const BUILTIN_RULES = Object.freeze([
  { name: COLLAPSE_RULE_NAME, detector: "collapse", source: "builtin", summary: "abort the stream, truncate the garbage from history, inject a corrective nudge, then continue" },
  { name: CONTROL_LEAK_RULE_NAME, detector: "control-leak", source: "builtin", summary: "abort the stream, replace the generation with an error shell, then resample via bounded provider retry" },
  { name: REPETITIVE_TURNS_RULE_NAME, detector: "repetitive-turns", source: "builtin", summary: "nudge when consecutive assistant turns repeat the same near-identical status" },
]);

function parseDisabledRules(raw) {
  return typeof raw === "string" && raw.length > 0
    ? raw.split(",").map((name) => name.trim()).filter(Boolean)
    : [];
}

function formatTtsrStatus(state) {
  return [
    "TTSR stream rules",
    "",
    "STATUS",
    state.disabled ? "disabled (ttsr-disabled flag set)" : "enabled",
    "",
    "BUILTIN RULES",
    ...BUILTIN_RULES.map((rule) => rule.name + " [detector: " + rule.detector + "] remediation: " + rule.summary),
    "",
    "DISABLED",
    state.disabledRules.length === 0 ? "(none)" : state.disabledRules.join(", "),
  ].join("\n");
}

export function createTtsrExtension() {
  return (pi) => {
    pi.registerFlag("ttsr-disabled", { type: "boolean", default: false, description: "Disable TTSR stream-rule detection." });
    pi.registerFlag("ttsr-rules-disabled", { type: "string", default: "", description: "Comma-separated TTSR rule names to disable." });
    pi.registerCommand("ttsr", {
      description: "Show TTSR stream-rule status: builtin detectors, user rules, injected rules.",
      handler: async (_args, ctx) => {
        const disabled = pi.getFlag("ttsr-disabled") === true;
        const disabledRules = parseDisabledRules(pi.getFlag("ttsr-rules-disabled"));
        ctx.ui.notify(formatTtsrStatus({ disabled, disabledRules, rules: BUILTIN_RULES }), "info");
      },
    });
  };
}

export default createTtsrExtension;

