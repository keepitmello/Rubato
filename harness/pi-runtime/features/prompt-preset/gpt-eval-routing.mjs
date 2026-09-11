/** GPT-specific bridge to eval's model-aware Tool Guidelines. */
export function buildGptEvalRoutingTuning() {
    return "When `eval` is available, follow its Tool Guidelines for multi-call work.";
}
