// The model needs a user-message window carrier; the terminal needs a
// compactionSummary component. Do not reuse the model projection for display.
export function createContextTransitionMessage(summary, tokensBefore, timestamp) {
  return { role: "compactionSummary", summary, tokensBefore, timestamp };
}
