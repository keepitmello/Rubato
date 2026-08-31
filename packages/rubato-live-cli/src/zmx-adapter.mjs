import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { isUuidV7, isZmxName, zmxNameForLiveSession } from "./identifiers.mjs";

export function defaultZmxBinary(home = homedir()) {
  return join(home, ".local", "lib", "rubato", "bin", "zmx");
}

export function parseLabels(text) {
  const labels = {};
  for (const field of String(text).trim().split(/\s+/)) {
    if (!field) continue;
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    labels[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return labels;
}

export function fixedRubatoLabels({ liveSessionId, hostId, buildId = "unknown" }) {
  if (!isUuidV7(liveSessionId) || !isUuidV7(hostId)) throw new TypeError("Rubato zmx labels require protocol UUIDv7 identifiers");
  return {
    app: "rubato",
    rubato_protocol: "1",
    rubato_live_id: liveSessionId,
    rubato_host_id: hostId,
    rubato_build_id: String(buildId || "unknown").replace(/[^A-Za-z0-9._-]/g, "-"),
  };
}

function withoutNestedSession(env) {
  const next = { ...env };
  delete next.ZMX_SESSION;
  return next;
}

export class ZmxAdapter {
  constructor({ binary = process.env.RUBATO_ZMX_BIN || defaultZmxBinary(), spawn = spawnSync, env = process.env } = {}) {
    this.binary = binary;
    this.spawn = spawn;
    this.env = env;
  }

  invoke(args, options = {}) {
    const result = this.spawn(this.binary, args, {
      encoding: "utf8",
      env: { ...(options.env ?? this.env), ZMX_NO_DETACH_KEY: "1" },
      stdio: options.stdio,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "").trim();
      throw new Error(`zmx ${args[0]} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  available() {
    const result = this.spawn(this.binary, ["version"], { encoding: "utf8", env: this.env });
    return !result.error && result.status === 0;
  }

  listNames() {
    const result = this.spawn(this.binary, ["list", "--short"], { encoding: "utf8", env: this.env });
    if (result.error?.code === "ENOENT") throw result.error;
    if (result.status !== 0) {
      if (/no sessions found/i.test(String(result.stderr ?? ""))) return [];
      throw new Error(`zmx list exited with ${result.status}`);
    }
    return String(result.stdout ?? "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  }

  labels(name) {
    return parseLabels(this.invoke(["get", name]).stdout);
  }

  setLabels(name, labels) {
    const fields = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
    this.invoke(["set", name, ...fields]);
  }

  runDetached(name, command) {
    if (!isZmxName(name)) throw new TypeError("invalid Rubato zmx name");
    this.invoke(["run", name, "-d", command]);
  }

  attach(name) {
    if (!isZmxName(name)) throw new TypeError("invalid Rubato zmx name");
    return this.invoke(["attach", name], { stdio: "inherit", env: withoutNestedSession(this.env) });
  }

  kill(name) {
    if (!isZmxName(name)) throw new TypeError("invalid Rubato zmx name");
    this.invoke(["kill", name]);
  }

  reconcile() {
    const sessions = [];
    for (const name of this.listNames()) {
      if (!isZmxName(name)) continue;
      const labels = this.labels(name);
      const liveSessionId = labels.rubato_live_id;
      if (
        labels.app !== "rubato" || labels.rubato_protocol !== "1" ||
        !isUuidV7(liveSessionId) || !isUuidV7(labels.rubato_host_id) || zmxNameForLiveSession(liveSessionId) !== name
      ) continue;
      sessions.push({
        liveSessionId,
        zmxName: name,
        hostId: labels.rubato_host_id,
        buildId: labels.rubato_build_id,
        managed: true,
      });
    }
    return sessions;
  }
}
