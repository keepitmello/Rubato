import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function pathExists(value) {
  try { return existsSync(value); }
  catch { return false; }
}

function findCheckoutRoot(fromDir) {
  let dir = fromDir;
  for (let depth = 0; depth < 12; depth += 1) {
    if (pathExists(join(dir, "packages", "rubato-remote-protocol", "src", "index.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function protocolSourceMtime(srcDir) {
  let latest = 0;
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const stamp = statSync(join(srcDir, name)).mtimeMs;
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

function bunExecutable() {
  const fromEnv = process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : undefined;
  for (const candidate of [fromEnv, join(process.env.HOME ?? "", ".bun/bin/bun"), "bun"]) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

export function resolveRemoteProtocolSource({
  env = process.env,
  fromFile = fileURLToPath(import.meta.url),
} = {}) {
  const override = typeof env.RUBATO_REMOTE_PROTOCOL === "string" ? env.RUBATO_REMOTE_PROTOCOL.trim() : "";
  if (override) return { source: "env", path: override };
  const checkoutRoot = findCheckoutRoot(dirname(fromFile));
  if (!checkoutRoot) throw new Error("rubato-remote-protocol checkout was not found");
  return {
    source: "checkout",
    path: join(tmpdir(), "rubato-remote-protocol-bundle", "protocol.mjs"),
    entry: join(checkoutRoot, "packages/rubato-remote-protocol/src/index.ts"),
    checkoutRoot,
  };
}

export async function loadRemoteProtocol(options = {}) {
  const resolved = resolveRemoteProtocolSource(options);
  let modulePath = resolved.path;
  if (resolved.source === "checkout") {
    const srcDir = dirname(resolved.entry);
    const bun = bunExecutable();
    if (!bun) throw new Error("loading checkout protocol requires bun to bundle TypeScript");
    if (!pathExists(modulePath) || statSync(modulePath).mtimeMs < protocolSourceMtime(srcDir)) {
      mkdirSync(dirname(modulePath), { recursive: true });
      const result = spawnSync(bun, ["build", resolved.entry, "--outfile", modulePath, "--target", "node", "--format", "esm"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (result.status !== 0) {
        throw new Error(`protocol bundle failed: ${String(result.stderr || result.stdout || result.status).trim()}`);
      }
    }
  }
  const href = pathToFileURL(modulePath).href;
  const module = options.importModule ? await options.importModule(href) : await import(href);
  return { module, source: resolved.source, path: modulePath };
}
