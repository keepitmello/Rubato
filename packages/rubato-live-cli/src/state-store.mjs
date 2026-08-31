import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createUuidV7, isUuidV7 } from "./identifiers.mjs";

export function defaultRemoteStateDirectory(home = homedir()) {
  return join(home, "Library", "Application Support", "Rubato", "remote");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export class LiveStateStore {
  constructor(directory = defaultRemoteStateDirectory()) {
    this.directory = directory;
    // Legacy test/local lifecycle state must never share the hub-owned host.json.
    this.hostPath = join(directory, "legacy-live-host-id.json");
    this.launchesPath = join(directory, "live-launches.json");
  }

  hostId() {
    const current = readJson(this.hostPath, undefined);
    if (isUuidV7(current?.hostId)) return current.hostId;
    const hostId = createUuidV7();
    atomicJson(this.hostPath, { schemaVersion: 1, hostId });
    return hostId;
  }

  list() {
    const document = readJson(this.launchesPath, { schemaVersion: 1, sessions: [] });
    return Array.isArray(document.sessions) ? document.sessions.filter((entry) => entry && typeof entry === "object") : [];
  }

  replace(sessions) {
    atomicJson(this.launchesPath, { schemaVersion: 1, sessions });
  }

  upsert(session) {
    const sessions = this.list();
    const index = sessions.findIndex((entry) => entry.liveSessionId === session.liveSessionId);
    if (index >= 0) sessions[index] = { ...sessions[index], ...session };
    else sessions.push(session);
    this.replace(sessions);
    return session;
  }

  remove(liveSessionId) {
    this.replace(this.list().filter((entry) => entry.liveSessionId !== liveSessionId));
  }
}
