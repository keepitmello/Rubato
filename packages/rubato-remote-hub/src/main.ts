import type { Server as HttpServer } from "node:http"
import { stat } from "node:fs/promises"
import type { BootstrapLaunchPayload } from "@rubato/remote-protocol"
import { TerminalLaunchTicketStore } from "@rubato/terminal-bridge"
import { homedir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { SessionActionQueue } from "./action-queue.js"
import { defaultHubPaths, ensureHostConfig, loadHostConfig, saveHostConfig } from "./config.js"
import { EnvironmentHandoffStore, EnvironmentVault, MacKeychainKeyStore } from "./environment.js"
import { RemoteHub } from "./hub.js"
import { createHttpApp } from "./http.js"
import { TailscaleServeIdentityVerifier } from "./identity.js"
import { EventJournal } from "./journal.js"
import { PairingService } from "./pairing.js"
import { findAvailableHubPort } from "./ports.js"
import { AllowedPathResolver } from "./path-security.js"
import { PushProfileStore, WebPushTransport } from "./push.js"
import { LiveRegistry } from "./registry.js"
import { SurfaceReconnectCredentials } from "./surface-credentials.js"
import { SurfaceTokenStore } from "./surface-tokens.js"
import { tailscalePairingBaseUrl } from "./tailscale.js"
import { TicketStore } from "./tickets.js"
import { SurfaceSocketServer } from "./unix-server.js"
import { uuidV7 } from "./uuid.js"
import { HubWebSocketServer } from "./websocket.js"
import { ExecFileRunner, ZmxProcessAdapter } from "./zmx.js"

const paths = defaultHubPaths()
const storedConfig = await ensureHostConfig(paths.host, {
  ...(process.env["RUBATO_HOST_DISPLAY_NAME"] === undefined ? {} : { displayName: process.env["RUBATO_HOST_DISPLAY_NAME"] }),
  ...(process.env["RUBATO_OWNER_LOGIN"] === undefined ? {} : { ownerLogin: process.env["RUBATO_OWNER_LOGIN"] }),
})
const selectedPort = await findAvailableHubPort(storedConfig.httpPort)
const config = selectedPort === storedConfig.httpPort ? storedConfig : { ...storedConfig, httpPort: selectedPort }
if (config !== storedConfig) await saveHostConfig(paths.host, config)
const zmxPath = process.env["RUBATO_ZMX_PATH"] ?? join(homedir(), ".local/lib/rubato/bin/zmx")
const zmx = new ZmxProcessAdapter({
  zmx: zmxPath,
  bootstrap: process.env["RUBATO_BOOTSTRAP_PATH"] ?? join(homedir(), ".local/lib/rubato/current/bin/rubato-live-bootstrap"),
  descriptorRoot: join(paths.root, "launch"),
})
const registry = new LiveRegistry(config.hostId, zmx)
const journal = new EventJournal(paths.journal, paths.snapshots, config.hostId)
const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
const surfaceTokens = new SurfaceTokenStore()
const surfaceCredentials = new SurfaceReconnectCredentials(join(paths.keys, "surface-credentials-key"))
const surfaceServer = new SurfaceSocketServer(paths.socket, registry, journal, surfaceTokens, handoffs, surfaceCredentials)
const actions = new SessionActionQueue(surfaceServer, (id) => journal.lastSeq(id))
const vault = new EnvironmentVault(join(paths.root, "launch-env.enc"), new MacKeychainKeyStore())
const hub = new RemoteHub({
  registry,
  journal,
  actions,
  controller: zmx,
  paths: new AllowedPathResolver([homedir()]),
  vault,
  handoffs,
  surfaceTokens,
  newLiveSessionId: uuidV7,
  runtime: {
    socketPath: paths.socket,
    launcherPath: process.env["RUBATO_LAUNCHER_PATH"] ?? join(homedir(), ".local/lib/rubato/current/bin/rubato"),
    zmxBinary: zmxPath,
    buildId: process.env["RUBATO_BUILD_ID"] ?? "unknown",
  },
})
const pairing = new PairingService(paths.origins)
const push = new PushProfileStore(paths.push, new WebPushTransport(`mailto:${config.ownerLogin}`))
const tickets = new TicketStore()
const terminalTickets = new TerminalLaunchTicketStore()
const identity = new TailscaleServeIdentityVerifier()
const configuredPairingBaseUrl = parsePairingBaseUrl(process.env["RUBATO_REMOTE_BASE_URL"])
const systemRunner = new ExecFileRunner()
surfaceServer.setControl(hub, {
  pairing,
  pairingBaseUrl: async () => configuredPairingBaseUrl ?? tailscalePairingBaseUrl(
    systemRunner,
    process.env["RUBATO_TAILSCALE_PATH"] ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ),
  doctor: async () => {
    const checks = await Promise.all([
      doctorCheck("host-config", async () => { await loadHostConfig(paths.host) }),
      doctorCheck("unix-socket", async () => {
        const info = await stat(paths.socket)
        if ((info.mode & 0o077) !== 0) throw new Error("socket is not owner-only")
      }),
      doctorCheck("zmx", async () => { await zmx.health() }),
    ])
    return { ok: checks.every((check) => check.status === "pass"), checks }
  },
})

await Promise.all([pairing.load(), push.load(), hub.start(), surfaceServer.listen()])
const app = createHttpApp({ config, hub, pairing, tickets, terminalTickets, identity, push })
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.httpPort }) as HttpServer
const sockets = new HubWebSocketServer({ server, identity, ownerLogin: config.ownerLogin, pairing, tickets, terminalTickets, journal, zmxBinary: zmxPath })

const stop = async (): Promise<void> => {
  sockets.close()
  await surfaceServer.close()
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()))
}
process.once("SIGINT", () => void stop().finally(() => process.exit(0)))
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)))

function parsePairingBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("RUBATO_REMOTE_BASE_URL must be an HTTPS URL without credentials")
  return url.href
}

async function doctorCheck(id: string, check: () => Promise<void>): Promise<{ id: string; status: "pass" | "fail"; detail?: string }> {
  try {
    await check()
    return { id, status: "pass" }
  } catch (error) {
    return { id, status: "fail", detail: error instanceof Error ? error.message : "check failed" }
  }
}
