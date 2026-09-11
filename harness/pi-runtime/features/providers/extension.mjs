import { directProviders } from "./src/provider-direct.mjs";
import { admitProviders } from "./src/provider-capabilities.mjs";
import { registerAntigravityLifecycle } from "./src/antigravity-route.mjs";
import { join } from "node:path";
import { DIRECT_PROVIDER_IDS } from "./src/provider-direct.mjs";
import { builtinProviderIds, foreignProviderIds } from "./src/provider-ids.mjs";
import { importLegacyDirectCredentials, unavailableDirectProviders } from "./src/credential-import.mjs";
import { registerAccountCommand } from "./auth-pool/accounts.mjs";

/**
 * Build the exact Rubato provider vector against this staged stock pi-ai.
 * Every dependency remains injectable for credential-free transport tests;
 * the default path is the production stock factories plus owned routes.
 */
export async function createRubatoProviders(options = {}) {
  return directProviders(options);
}

/**
 * Stock Pi ExtensionFactory. Admission finishes before the first registry
 * write, and the Antigravity state lifecycle is attached after registration.
 */
export function createProvidersExtension(options = {}) {
  return async (pi) => {
    const env = options.env ?? process.env;
    const antigravity = options.antigravity ?? {};
    const agentDir = options.agentDir ?? env.RUBATO_PI_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR;
    if (typeof agentDir !== "string" || agentDir.length === 0) {
      throw new Error("providers: agentDir is required (options.agentDir or RUBATO_PI_CODING_AGENT_DIR / PI_CODING_AGENT_DIR)");
    }
    const legacyPath = options.legacyPath ?? env.RUBATO_LEGACY_AUTH_PATH;
    if (legacyPath) {
      const report = await importLegacyDirectCredentials({
        ...options,
        env,
        legacyPath,
        targetPath: env.RUBATO_TARGET_AUTH_PATH ?? join(agentDir, "auth.json"),
      });
      const unavailable = await unavailableDirectProviders(report, env, options);
      const blocking = unavailable.filter((entry) => entry.reason !== "absent");
      if (blocking.length > 0) {
        throw new Error(
          "providers: cannot use " +
          `${blocking.map((entry) => `${entry.id}(${entry.reason})`).join(" ")}` +
          ": the legacy store could not be used and the target has no valid credential for it. Log in again.",
        );
      }
      const rejectedIds = Object.keys(report.rejected ?? {});
      const degraded = report.status !== "imported" && report.status !== "nothing_to_import" && report.status !== "legacy_absent" && report.status !== "same_path";
      if (degraded || rejectedIds.length > 0) {
        console.warn(
          `providers: legacy credential import incomplete (status=${report.status}` +
          `${rejectedIds.length > 0 ? `, rejected=${rejectedIds.join(" ")}` : ""})`,
        );
      }
    }
    const providers = await createRubatoProviders({ ...options, antigravity, env });
    const admitted = admitProviders(pi, providers);
    if (antigravity.stateStore && antigravity.lineage) {
      registerAntigravityLifecycle(pi, { ...antigravity, env });
    }
    if (typeof pi.unregisterProvider === "function") {
      for (const id of foreignProviderIds(builtinProviderIds())) {
        if (DIRECT_PROVIDER_IDS.includes(id)) continue;
        try { pi.unregisterProvider(id); } catch { /* keep a host-owned leftover visible */ }
      }
    }
    registerAccountCommand(pi, {
      env,
      poolStatePath: typeof agentDir === "string" && agentDir.length > 0
        ? join(agentDir, "credential-pool-state.json")
        : undefined,
    });
    return admitted;
  };
}

export default createProvidersExtension();
