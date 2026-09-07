import { directProviders } from "./src/provider-direct.mjs";
import { admitProviders } from "./src/provider-capabilities.mjs";
import { registerAntigravityLifecycle } from "./src/antigravity-route.mjs";

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
    const antigravity = options.antigravity ?? {};
    const providers = await createRubatoProviders({ ...options, antigravity });
    const admitted = admitProviders(pi, providers);
    if (antigravity.stateStore && antigravity.lineage) {
      registerAntigravityLifecycle(pi, { ...antigravity, env: options.env });
    }
    return admitted;
  };
}

export default createProvidersExtension();
