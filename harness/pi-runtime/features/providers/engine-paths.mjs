import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This module is staged at:
//   <selected pi-ai>/dist/rubato-features/providers/src/engine-paths.mjs
// Resolve only that selected stock package. There is deliberately no HOME,
// workspace, Senpi, or process-wide module fallback.
const here = dirname(fileURLToPath(import.meta.url));
export const piAiRoot = resolve(here, "../../../..");
export const senpiDir = resolve(piAiRoot, "../../..");

export function senpiNested(...segments) {
  const path = segments.join("/");
  const prefix = "@earendil-works/pi-ai";
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new Error(`providers feature cannot resolve non-stock nested package: ${path}`);
  }
  return join(piAiRoot, path.slice(prefix.length).replace(/^\/+/, ""));
}
