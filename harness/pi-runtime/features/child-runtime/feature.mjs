import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const featureDir = dirname(fileURLToPath(import.meta.url))

/** Runtime-owned adapter payload for task/team child process selection. */
export const childRuntimeFeature = Object.freeze({
  id: "child-runtime",
  patches: [],
  files: [
    {
      target: "runtime",
      version: "0.85.1",
      path: "rubato-features/child-runtime/stock-rpc-runtime.mjs",
      sourcePath: join(featureDir, "stock-rpc-runtime.mjs"),
    },
    {
      target: "runtime",
      version: "0.85.1",
      path: "rubato-features/child-runtime/provider-extension.mjs",
      sourcePath: join(featureDir, "provider-extension.mjs"),
    },
    {
      target: "runtime",
      version: "0.85.1",
      path: "rubato-features/child-runtime/guard-extension.mjs",
      sourcePath: join(featureDir, "guard-extension.mjs"),
    },
  ],
})

export default childRuntimeFeature
