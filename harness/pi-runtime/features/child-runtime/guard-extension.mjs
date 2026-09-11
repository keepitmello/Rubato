import { createToolGuardExtensionFactories } from "../tool-guards/index.mjs"

/** Child-safe guard subset; no task/MCP/UI state or parent-bound services. */
export function createStockChildGuardExtension() {
  const factories = createToolGuardExtensionFactories().filter(({ name }) => name !== "rubato-gpt-apply-patch")
  return (pi) => factories.reduce((result, entry) => result.then(() => entry.factory(pi)), Promise.resolve())
}

export default createStockChildGuardExtension()
