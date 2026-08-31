import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const RELEASE_SCHEMA_VERSION = 1
export const SUPPORTED_BUN_VERSION = "1.4.0"
export const MINIMUM_NODE_MAJOR = 24
export const HUB_LABEL = "com.keepitmello.rubato.remote-hub"
export const HUB_PORT_MIN = 7314
export const HUB_PORT_MAX = 7399
export const REMOTE_PATH = "/rubato/"
export const ZMX_COMMIT = "0266042ca8f399c9d76825739b93443e2d5bf47a"
export const REDACTED = "[REDACTED]"

export function defaultPaths(home = homedir(), uid = process.getuid?.() ?? 0) {
  const state = join(home, "Library", "Application Support", "Rubato", "remote")
  const library = join(home, ".local", "lib", "rubato")
  return {
    home,
    state,
    host: join(state, "host.json"),
    owner: join(state, "owner.json"),
    origins: join(state, "origins.json"),
    serveState: join(state, "serve-state.json"),
    installerStateKey: join(state, "keys", "installer-state-ed25519.pem"),
    baseline: join(state, "launch-env.enc"),
    logs: join(state, "logs"),
    push: join(state, "push"),
    keys: join(state, "keys"),
    journal: join(state, "journal"),
    snapshots: join(state, "snapshots"),
    artifacts: join(state, "artifacts"),
    audit: join(state, "audit"),
    pair: join(state, "pair"),
    library,
    releases: join(library, "remote", "releases"),
    current: join(library, "remote", "current"),
    zmx: join(library, "bin", "zmx"),
    socket: join(tmpdir(), `rubato-remote-${uid}`, "hub.sock"),
    plist: join(home, "Library", "LaunchAgents", `${HUB_LABEL}.plist`),
  }
}
