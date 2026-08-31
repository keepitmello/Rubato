import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createUuidV7, isUuidV7, isZmxName, zmxNameForLiveSession } from "./identifiers.mjs";
import { bootstrapCommand, OneTimeLaunchBroker } from "./launch-handoff.mjs";
import { fixedRubatoLabels } from "./zmx-adapter.mjs";

function sessionFileFromArgs(args, cwd) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--session") return args[index + 1] ? resolve(cwd, args[index + 1]) : undefined;
    if (args[index].startsWith("--session=")) return resolve(cwd, args[index].slice("--session=".length));
  }
  return undefined;
}

function resolveDirectory(cwd) {
  const path = resolve(cwd);
  if (!statSync(path).isDirectory()) throw new Error(`working directory is not a directory: ${path}`);
  return path;
}

function normalizedPrefix(value) {
  return String(value).toLowerCase().replaceAll("-", "");
}

export class LiveLifecycle {
  constructor({
    zmx,
    store,
    handoff = new OneTimeLaunchBroker(),
    launcherPath,
    bootstrapPath,
    nodePath = process.execPath,
    env = process.env,
    buildId = env.RUBATO_BUILD_ID || "unknown",
  }) {
    if (!zmx || !store || !launcherPath || !bootstrapPath) throw new TypeError("live lifecycle requires zmx, store, launcher, and bootstrap ports");
    this.zmx = zmx;
    this.store = store;
    this.handoff = handoff;
    this.launcherPath = launcherPath;
    this.bootstrapPath = bootstrapPath;
    this.nodePath = nodePath;
    this.env = env;
    this.buildId = buildId;
  }

  async create({ cwd = process.cwd(), name, detach = false, args = [], environment = this.env } = {}) {
    if (this.env.ZMX_SESSION && !detach) {
      throw new Error("already inside zmx; use `rubato new --detach` to avoid a nested session");
    }
    const liveSessionId = createUuidV7();
    const hostId = this.store.hostId();
    const zmxName = zmxNameForLiveSession(liveSessionId);
    const labels = fixedRubatoLabels({ liveSessionId, hostId, buildId: this.buildId });
    const launchCwd = resolveDirectory(cwd);
    const surfaceToken = randomBytes(32).toString("hex");
    const prepared = await this.handoff.prepare({
      schemaVersion: 1,
      liveSessionId,
      hostId,
      zmxName,
      labels,
      cwd: launchCwd,
      argv: [...args],
      env: { ...environment },
      launcherPath: this.launcherPath,
      zmxBinary: this.zmx.binary,
      hubSocket: this.env.RUBATO_HUB_SOCKET || "/tmp/rubato-local-handoff.sock",
      surfaceToken,
    });
    const command = bootstrapCommand({
      nodePath: this.nodePath,
      bootstrapPath: this.bootstrapPath,
      descriptorPath: prepared.descriptorPath,
    });
    try {
      this.zmx.runDetached(zmxName, command);
      await prepared.consumed;
      // Bootstrap also sets these labels. Repeating the idempotent write here makes
      // create()'s return the readiness boundary for immediate list/reconcile calls.
      this.zmx.setLabels(zmxName, labels);
    } catch (error) {
      prepared.cancel?.();
      throw error;
    }
    const session = this.store.upsert({
      schemaVersion: 1,
      liveSessionId,
      hostId,
      zmxName,
      managed: true,
      cwd: launchCwd,
      ...(name ? { title: name } : {}),
      ...(sessionFileFromArgs(args, launchCwd) ? { sessionFile: sessionFileFromArgs(args, launchCwd) } : {}),
      createdAt: new Date().toISOString(),
    });
    if (!detach) this.zmx.attach(zmxName);
    return session;
  }

  reconcile() {
    const discovered = this.zmx.reconcile();
    const existing = new Map(this.store.list().map((entry) => [entry.liveSessionId, entry]));
    const sessions = discovered.map((entry) => ({ ...existing.get(entry.liveSessionId), ...entry }));
    this.store.replace(sessions);
    return sessions;
  }

  list() {
    return this.reconcile();
  }

  resolve(value) {
    if (!value) throw new Error("a live session id or prefix is required");
    const compact = normalizedPrefix(value);
    const matches = this.list().filter((session) =>
      normalizedPrefix(session.liveSessionId).startsWith(compact) ||
      session.zmxName.toLowerCase().startsWith(String(value).toLowerCase()),
    );
    if (matches.length === 0) throw new Error(`live session not found: ${value}`);
    if (matches.length > 1) throw new Error(`live session prefix is ambiguous: ${value}`);
    return matches[0];
  }

  attach(value) {
    const session = this.resolve(value);
    this.zmx.attach(session.zmxName);
    return session;
  }

  kill(value, _force = false) {
    const session = this.resolve(value);
    this.zmx.kill(session.zmxName);
    this.store.remove(session.liveSessionId);
    return session;
  }

  async vaultResume(sessionFile, options = {}) {
    const path = resolve(sessionFile);
    const active = this.list().find((session) => session.sessionFile === path);
    if (active) {
      this.zmx.attach(active.zmxName);
      return { attached: true, session: active };
    }
    return { attached: false, session: await this.create({ ...options, args: ["--session", path] }) };
  }

  async vaultFork(sessionFile, options = {}) {
    return this.create({ ...options, args: ["--fork", resolve(sessionFile)] });
  }
}

export function assertReconciledSession(session) {
  return Boolean(
    isUuidV7(session?.liveSessionId) && isZmxName(session?.zmxName) &&
    zmxNameForLiveSession(session.liveSessionId) === session.zmxName,
  );
}
