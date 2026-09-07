export const BUILD_RECEIPT_VERSION = 1;
export const BUNDLE_ENTRIES = Object.freeze({
  "extensions/rubato.js": "harness/pi-runtime/features/rubato-components/entry.ts",
  "extensions/rubato-task.js": "packages/rubato-runtime/src/extension/rubato-task.ts",
  "extensions/rubato-member.js": "packages/senpi-task/src/team/member-extension/index.ts",
  "extensions/rubato-memory-mcp.js": "packages/rubato-runtime/src/mcp/memory-server.ts",
  "extensions/memory-run-supervisor.mjs": "packages/rubato-runtime/src/components/memory/worker/memory-run-supervisor.ts",
  "runtime/ast-grep-mcp/cli.js": "packages/ast-grep-mcp/src/cli.ts",
  "runtime/lsp-daemon/dist/cli.js": "packages/lsp-daemon/src/cli.ts",
});
export const SOURCE_ASSETS = Object.freeze({
  "extensions/reflection-persona.md": "packages/memory-core/src/reflection/assets/reflection-persona.md",
  "extensions/dream-persona.md": "packages/memory-core/src/reflection/assets/dream-persona.md",
  "extensions/facts-persona.md": "packages/memory-core/src/facts/assets/facts-persona.md",
  "LICENSE.md": "LICENSE.md",
  "THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
  "LICENSE": "packages/rubato-runtime/plugin/LICENSE",
  "NOTICE": "packages/rubato-runtime/plugin/NOTICE",
  "runtime/lsp-daemon/NOTICE": "packages/lsp-daemon/NOTICE",
  "runtime/lsp-daemon/lsp-core-NOTICE": "packages/lsp-core/NOTICE",
  "bootstrap.mjs": "harness/pi-runtime/features/rubato-components/bootstrap.mjs",
  "payload-manifest.mjs": "harness/pi-runtime/features/rubato-components/payload-manifest.mjs",
});
export const REQUIRED_PAYLOADS = Object.freeze([
  ...Object.keys(BUNDLE_ENTRIES), ...Object.keys(SOURCE_ASSETS),
  "runtime/lsp-daemon/dist/package.json", "package.json",
]);

export function validateBuildReceipt(receipt, { stockVersion, lockSha256 }) {
  if (receipt?.version !== BUILD_RECEIPT_VERSION || receipt.state !== "ready" ||
      receipt.stockVersion !== stockVersion || receipt.fullRubatoParity !== false ||
      receipt.lockSha256 !== lockSha256) throw new Error("Rubato build receipt does not match the selected runtime/schema");
  if (!Array.isArray(receipt.bundles) || !Array.isArray(receipt.assets)) throw new Error("Invalid Rubato build payload manifest");
  const entries = [...receipt.bundles, ...receipt.assets];
  const declared = new Set(entries.map((entry) => entry?.path));
  if (declared.size !== entries.length || REQUIRED_PAYLOADS.some((path) => !declared.has(path)) ||
      entries.some((entry) => typeof entry?.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
    throw new Error("Rubato build manifest is missing required payloads or contains invalid/duplicate paths");
  }
  return entries;
}
