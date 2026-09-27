import { createToolSearchExtension } from "../tool-search/index.mjs"

/**
 * The child's own tool catalog. The tool-search engine patch puts every extension tool that
 * declares no exposure (and every tool declared "search", e.g. the notes tools) behind
 * tool_search in every session, child included. Without this extension a child registers
 * those tools but can never activate them.
 */
export function createStockChildToolSearchExtension() {
  return createToolSearchExtension()
}

export default createStockChildToolSearchExtension()
