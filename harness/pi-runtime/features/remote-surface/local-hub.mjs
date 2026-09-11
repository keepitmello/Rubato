import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HubControlClient } from "../../../../packages/rubato-live-cli/src/hub-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = join(here, "../../../..");

function bunExecutable() {
  const fromEnv = process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun") : undefined;
  for (const candidate of [fromEnv, join(process.env.HOME ?? "", ".bun/bin/bun"), "bun"]) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) return candidate;
  }
  throw new Error("local hub bundle requires bun");
}

export const HOST_ID = "018f1e2d-3c4b-7a6f-8abc-1234567890ab";
export const LIVE_SESSION_ID = "018f1e2d-3c4b-7b6f-8abc-1234567890ab";

export function defaultLiveHubSocketPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `rubato-remote-${uid}`, "hub.sock");
}

export async function bundleLocalHub(outputDir) {
  const scratch = mkdtempSync(join(tmpdir(), "rubato-local-hub-src-"));
  try {
    mkdirSync(join(scratch, "src"), { recursive: true });
    mkdirSync(join(scratch, "node_modules/@rubato"), { recursive: true });
    cpSync(join(worktreeRoot, "packages/rubato-remote-hub/src"), join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src/local-hub-entry.ts"), [
      'export { SurfaceSocketServer } from "./unix-server.ts";',
      'export { LiveRegistry } from "./registry.ts";',
      'export { EventJournal } from "./journal.ts";',
      'export { SurfaceTokenStore } from "./surface-tokens.ts";',
      'export { SurfaceReconnectCredentials } from "./surface-credentials.ts";',
      'export { EnvironmentHandoffStore } from "./environment.ts";',
    ].join("\n") + "\n");
    // node_modules lives next to hub/src so @rubato/remote-protocol resolves from copied files.
    spawnSync("ln", ["-s", join(worktreeRoot, "packages/rubato-remote-protocol"), join(scratch, "node_modules/@rubato/remote-protocol")], { timeout: 5_000 });
    mkdirSync(outputDir, { recursive: true });
    const outfile = join(outputDir, "hub.mjs");
    const bun = bunExecutable();
    const result = spawnSync(bun, ["build", join(scratch, "src/local-hub-entry.ts"), "--outfile", outfile, "--target", "node", "--format", "esm"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`local hub bundle failed: ${String(result.stderr || result.stdout || result.status).trim()}`);
    }
    return outfile;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function startLocalHub(root) {
  mkdirSync(root, { recursive: true });
  const bundlePath = await bundleLocalHub(join(root, "bundle"));
  const hub = await import(pathToFileURL(bundlePath).href);
  const socketPath = join(root, "socket", "hub.sock");
  if (socketPath === defaultLiveHubSocketPath()) {
    throw new Error("local hub refuses to bind the live hub socket");
  }
  const registry = new hub.LiveRegistry(HOST_ID, { discover: async () => [] });
  const journal = new hub.EventJournal(join(root, "journal"), join(root, "snapshots"), HOST_ID);
  await journal.load();
  const tokens = new hub.SurfaceTokenStore();
  const handoffs = new hub.EnvironmentHandoffStore();
  const credentials = new hub.SurfaceReconnectCredentials(join(root, "credentials-key"));
  const server = new hub.SurfaceSocketServer(socketPath, registry, journal, tokens, handoffs, credentials);
  server.setControl({
    resolve() { throw new Error("session_not_found"); },
    async create() { throw new Error("not_supported"); },
    async terminate() { return undefined; },
    async saveBaseline() { return ""; },
    async noteExited(id) { registry.remove?.(id); },
  });
  await server.listen();
  const control = new HubControlClient({ socketPath, timeoutMs: 5_000 });
  return {
    hostId: HOST_ID,
    socketPath,
    registry,
    tokens,
    server,
    control,
    issueToken(liveSessionId) { return tokens.issue(liveSessionId); },
    async list() { return (await control.request("cli.list")).sessions; },
    dispatch(request) { return server.dispatch(request); },
    async close() { await server.close(); },
  };
}
