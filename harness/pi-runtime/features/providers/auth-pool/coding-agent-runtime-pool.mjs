// Re-export pi-ai's pool from the pi-ai package that this coding-agent copy resolves.
// 0.86.1 nested pi-ai under pi-coding-agent/node_modules; 1.0.1 installs it as a sibling.
// Resolving the package keeps one module instance (same URL) in either layout.
const piAiIndex = import.meta.resolve("@earendil-works/pi-ai");
export const { streamWithCredentialPool } = await import(
  new URL("./rubato-features/providers/auth-pool/runtime-pool.mjs", piAiIndex).href
);
