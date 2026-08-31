import { statSync } from "node:fs";
import { claimLaunchDescriptor } from "./launch-handoff.mjs";
import { isUuidV7, isZmxName, zmxNameForLiveSession } from "./identifiers.mjs";
import { ZmxAdapter } from "./zmx-adapter.mjs";

function stringEnvironment(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("launch environment must be an object");
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => key && typeof value === "string"));
}

export function validateLaunchPayload(payload) {
  if (payload?.schemaVersion !== 1) throw new Error("unsupported launch payload");
  if (!isUuidV7(payload.liveSessionId) || !isUuidV7(payload.hostId)) throw new Error("launch payload identifiers violate remote protocol");
  if (!isZmxName(payload.zmxName) || zmxNameForLiveSession(payload.liveSessionId) !== payload.zmxName) throw new Error("launch payload zmx name does not match liveSessionId");
  if (typeof payload.cwd !== "string" || !statSync(payload.cwd).isDirectory()) throw new Error("launch working directory is invalid");
  if (!Array.isArray(payload.argv) || payload.argv.some((value) => typeof value !== "string")) throw new Error("launch argv must contain strings");
  if (!payload.labels || typeof payload.labels !== "object" || Array.isArray(payload.labels) || Object.values(payload.labels).some((value) => typeof value !== "string")) throw new Error("launch labels are invalid");
  if (typeof payload.launcherPath !== "string" || typeof payload.zmxBinary !== "string" || typeof payload.hubSocket !== "string") throw new Error("launch executable paths are missing");
  if (typeof payload.surfaceToken !== "string" || payload.surfaceToken.length < 32) throw new Error("launch surface token is invalid");
  return payload;
}

export async function runBootstrap(descriptorPath, {
  claim = claimLaunchDescriptor,
  execve = process.execve,
  env = process.env,
  chdir = process.chdir,
  zmxFactory = (binary, nextEnv) => new ZmxAdapter({ binary, env: nextEnv }),
} = {}) {
  const payload = validateLaunchPayload(await claim(descriptorPath));
  if (env.ZMX_SESSION !== payload.zmxName) throw new Error("bootstrap is not running in its assigned zmx session");
  const nextEnv = {
    ...stringEnvironment(payload.env),
    ZMX_SESSION: payload.zmxName,
    ZMX_NO_DETACH_KEY: "1",
    RUBATO_LIVE_SESSION_ID: payload.liveSessionId,
    RUBATO_HOST_ID: payload.hostId,
    RUBATO_HUB_SOCKET: payload.hubSocket,
    RUBATO_SURFACE_TOKEN: payload.surfaceToken,
  };
  const zmx = zmxFactory(payload.zmxBinary, nextEnv);
  zmx.setLabels(payload.zmxName, payload.labels);
  chdir(payload.cwd);
  if (typeof execve !== "function") throw new Error("Node runtime does not provide process.execve");
  execve(payload.launcherPath, [payload.launcherPath, "direct", ...payload.argv], nextEnv);
  throw new Error("execve returned unexpectedly");
}
