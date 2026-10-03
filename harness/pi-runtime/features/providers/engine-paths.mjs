import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This module is staged at:
//   <selected pi-ai>/dist/rubato-features/providers/src/engine-paths.mjs
// Resolve only that selected stock package. There is deliberately no HOME,
// workspace, Senpi, or process-wide module fallback.
const here = dirname(fileURLToPath(import.meta.url));
export const piAiRoot = resolve(here, "../../../..");

// The coding-agent package that owns this pi-ai copy. 0.86.1 nested pi-ai under
// pi-coding-agent/node_modules; 1.0.1 installs it as a sibling in the same scope.
function codingAgentDirFor(root) {
  const modules = dirname(dirname(root));
  const owner = dirname(modules);
  if (basename(modules) === "node_modules" && isCodingAgent(owner)) return owner;
  return join(dirname(root), "pi-coding-agent");
}

function isCodingAgent(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent";
  } catch {
    return false;
  }
}

export const senpiDir = codingAgentDirFor(piAiRoot);

export function senpiNested(...segments) {
  const path = segments.join("/");
  const prefix = "@earendil-works/pi-ai";
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new Error(`providers feature cannot resolve non-stock nested package: ${path}`);
  }
  return join(piAiRoot, path.slice(prefix.length).replace(/^\/+/, ""));
}
