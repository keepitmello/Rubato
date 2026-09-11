import { attachStockInteractiveControl } from "./stock-control.mjs";
import { loadRemoteProtocol } from "./protocol-loader.mjs";
import { installRemoteSurface } from "./surface.mjs";

export const REMOTE_SURFACE_FACTORY_NAME = "rubato-remote-surface";

/**
 * Candidate remote-surface factory. Explicit RUBATO_HUB_SOCKET (or options.socketPath /
 * options.connect / options.protocol) is required so a default candidate run cannot
 * attach to the user's LaunchAgent hub.
 */
export function createRemoteSurfaceExtension(options = {}) {
  return async function rubatoRemoteSurface(pi) {
    attachStockInteractiveControl(pi, options);
    const socketPath = options.socketPath ?? process.env.RUBATO_HUB_SOCKET;
    if (!options.connect && !socketPath && !options.protocol) return;
    let started = false;
    const start = async () => {
      if (started) return;
      started = true;
      const protocol = options.protocol ?? (await loadRemoteProtocol(options.protocolLoader ?? {})).module;
      await installRemoteSurface(pi, {
        ...options,
        protocol,
        ...(socketPath ? { socketPath } : {}),
      });
    };
    const kick = () => { void start().catch((error) => { console.error("[rubato-remote-surface] start failed:", error); }); };
    pi.on("session_start", kick);
  };
}

export function createRemoteSurfaceFactories(options = {}) {
  return [{ name: REMOTE_SURFACE_FACTORY_NAME, factory: createRemoteSurfaceExtension(options) }];
}

export { attachStockInteractiveControl } from "./stock-control.mjs";
export { installRemoteSurface, RemoteSurface, loadRemoteProtocol as loadSurfaceProtocol } from "./surface.mjs";
export { loadRemoteProtocol } from "./protocol-loader.mjs";

export default createRemoteSurfaceFactories;
