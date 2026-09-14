import { attachStockInteractiveControl } from "./stock-control.mjs";
import { loadRemoteProtocol } from "./protocol-loader.mjs";
import { installRemoteSurface } from "./surface.mjs";
import { STOCK_UI_HOST } from "./stock-ui-host.mjs";

export const REMOTE_SURFACE_FACTORY_NAME = "rubato-remote-surface";

/**
 * Candidate remote-surface factory. Explicit RUBATO_HUB_SOCKET (or options.socketPath /
 * options.connect / options.protocol) is required so a default candidate run cannot
 * attach to the user's LaunchAgent hub.
 */
export function createRemoteSurfaceExtension(options = {}) {
  return async function rubatoRemoteSurface(pi) {
    attachStockInteractiveControl(pi, options);
    let binding;
    const start = async (_event, ctx) => {
      const port = ctx.ui?.[STOCK_UI_HOST];
      // Pane identity belongs to its terminal, not the first SDK actor there.
      // GUI/headless actors must never inherit the engine starter's pane.
      if (options.hosted && !port) return;
      const key = port ?? pi;
      if (binding === key) return;
      const env = port?.env ?? options.env ?? process.env;
      const socketPath = options.socketPath ?? env.RUBATO_HUB_SOCKET;
      if (!options.connect && !socketPath && !options.protocol) return;
      binding = key;
      const protocol = options.protocol ?? (await loadRemoteProtocol(options.protocolLoader ?? {})).module;
      if (port && !port.active) { if (binding === key) binding = undefined; return; }
      const surface = await installRemoteSurface(pi, {
        ...options,
        protocol, env,
        ...(socketPath ? { socketPath } : {}),
      });
      surface.context = ctx;
      if (port?.hosted) {
        surface.presentationClose?.();
        surface.presentationBinding = port;
        surface.presentationClose = port.onClose(() => surface.stop());
        port.onDispose(() => {
          if (binding === key) binding = undefined;
          if (surface.presentationBinding !== port) return;
          surface.presentationBinding = undefined;
          surface.pi = undefined; surface.context = undefined; surface.dispatcher = undefined;
        });
      }
      surface.emitSnapshot();
      surface.rememberTimeline();
    };
    const kick = (event, ctx) => start(event, ctx).catch((error) => {
      binding = undefined;
      console.error("[rubato-remote-surface] start failed:", error);
    });
    pi.on("session_start", kick);
    pi.on("rubato.presentation.bind", kick);
  };
}

export function createRemoteSurfaceFactories(options = {}) {
  return [{ name: REMOTE_SURFACE_FACTORY_NAME, factory: createRemoteSurfaceExtension(options) }];
}

export { attachStockInteractiveControl } from "./stock-control.mjs";
export { installRemoteSurface, RemoteSurface, loadRemoteProtocol as loadSurfaceProtocol } from "./surface.mjs";
export { loadRemoteProtocol } from "./protocol-loader.mjs";

export default createRemoteSurfaceFactories;
