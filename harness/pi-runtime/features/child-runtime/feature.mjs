import { PI_VERSION } from "../../pi-version.mjs";
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
      version: PI_VERSION,
      path: "rubato-features/child-runtime/stock-rpc-runtime.mjs",
      sourcePath: join(featureDir, "stock-rpc-runtime.mjs"),
    },
    {
      target: "runtime",
      version: PI_VERSION,
      path: "rubato-features/child-runtime/provider-extension.mjs",
      sourcePath: join(featureDir, "provider-extension.mjs"),
    },
    {
      target: "runtime",
      version: PI_VERSION,
      path: "rubato-features/child-runtime/guard-extension.mjs",
      sourcePath: join(featureDir, "guard-extension.mjs"),
    },
    {
      target: "runtime",
      version: PI_VERSION,
      path: "rubato-features/child-runtime/role-prompt-extension.mjs",
      sourcePath: join(featureDir, "role-prompt-extension.mjs"),
    },
  ],
})

export default childRuntimeFeature
