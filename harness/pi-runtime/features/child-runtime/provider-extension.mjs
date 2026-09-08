import { createProvidersExtension } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/rubato-features/providers/extension.mjs"
import { createProviderExecution } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/rubato-features/provider-execution/extension.mjs"

/**
 * Child-only provider closure. The parent passes this file with --extension;
 * it registers the seven staged Rubato providers and binds the shared
 * provider-execution bridge, but does not load task/MCP/UI extensions.
 */
export function createStockChildProviderExtension(options = {}) {
  const execution = createProviderExecution(options)
  const providers = createProvidersExtension({
    ...options,
    routeFactories: {
      ...options.routeFactories,
      cursor: execution.cursorRouteFactory,
    },
  })
  return async (pi) => {
    execution.extension(pi)
    return providers(pi)
  }
}

export default createStockChildProviderExtension()
