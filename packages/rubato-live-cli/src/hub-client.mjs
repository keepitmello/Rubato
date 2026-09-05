import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeFrame, JsonFrameDecoder, REMOTE_PROTOCOL_NAME } from "./protocol-runtime.mjs";
import { ZmxAdapter } from "./zmx-adapter.mjs";

const PROTOCOL = REMOTE_PROTOCOL_NAME;
const LAUNCHD_LABEL = "com.keepitmello.rubato.remote-hub";

export class HubUnavailableError extends Error {
  constructor(message = "Rubato live session service is unavailable") {
    super(message);
    this.name = "HubUnavailableError";
    this.code = "HUB_UNAVAILABLE";
  }
}

export function defaultHubSocketPath(env = process.env) {
  if (env.RUBATO_HUB_SOCKET) return env.RUBATO_HUB_SOCKET;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `rubato-remote-${uid}`, "hub.sock");
}

function nextFrame(socket, timeoutMs) {
  return new Promise((resolveFrame, reject) => {
    const decoder = new JsonFrameDecoder();
    const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(new HubUnavailableError("hub control request timed out")); }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onData = (chunk) => {
      try {
        const values = decoder.push(chunk);
        if (values.length === 0) return;
        cleanup();
        resolveFrame(values[0]);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new HubUnavailableError("hub closed the control connection")); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function assertOwnerOnlySocket(path) {
  const info = statSync(path);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new HubUnavailableError("hub socket has the wrong owner");
  if ((info.mode & 0o077) !== 0) throw new HubUnavailableError("hub socket is not owner-only");
}

export class HubControlClient {
  constructor({ socketPath = defaultHubSocketPath(), timeoutMs = 2_000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(kind, fields = {}) {
    try { assertOwnerOnlySocket(this.socketPath); }
    catch (error) {
      if (error instanceof HubUnavailableError) throw error;
      throw new HubUnavailableError();
    }
    const socket = createConnection(this.socketPath);
    try {
      await new Promise((resolveConnect, reject) => {
        socket.once("connect", resolveConnect);
        socket.once("error", reject);
      });
      const requestId = randomUUID();
      const responsePromise = nextFrame(socket, this.timeoutMs);
      socket.write(encodeFrame({ kind, protocol: PROTOCOL, requestId, ...fields }));
      const response = await responsePromise;
      if (response?.kind !== "hub.control-result" || response.requestId !== requestId) throw new Error("invalid hub control response");
      if (response.ok !== true) throw new Error(String(response.error ?? "hub request failed"));
      return response.result;
    } catch (error) {
      if (error instanceof Error && ["session_not_found", "session_prefix_ambiguous", "path_not_allowed", "environment_not_configured", "invalid_request"].includes(error.message)) throw error;
      if (error instanceof HubUnavailableError) throw error;
      throw new HubUnavailableError();
    } finally {
      socket.destroy();
    }
  }
}

export class HubLifecycleClient {
  constructor({
    control = new HubControlClient(),
    zmx = new ZmxAdapter(),
    env = process.env,
    kickstart = defaultKickstart,
    wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
    startupTimeoutMs = 2_000,
  } = {}) {
    this.control = control;
    this.zmx = zmx;
    this.env = env;
    this.kickstart = kickstart;
    this.wait = wait;
    this.startupTimeoutMs = startupTimeoutMs;
    this.healthy = false;
  }

  async ensureHealthy() {
    if (this.healthy) return;
    try {
      await this.control.request("cli.health");
      this.healthy = true;
      return;
    } catch {}
    this.kickstart();
    const deadline = Date.now() + this.startupTimeoutMs;
    do {
      try {
        await this.control.request("cli.health");
        this.healthy = true;
        return;
      } catch {}
      if (Date.now() < deadline) await this.wait(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new HubUnavailableError();
  }

  async create({ cwd = process.cwd(), name, detach = false, args = [], environment = this.env } = {}) {
    if (this.env.ZMX_SESSION && !detach) throw new Error("already inside zmx; use `rubato new --detach` to avoid a nested session");
    await this.ensureHealthy();
    const result = await this.control.request("cli.create", {
      cwd: resolve(cwd),
      rubatoArgs: [...args],
      environment: stringEnvironment(environment),
      ...(name ? { name } : {}),
      ...(detach ? { persist: true } : {}),
    });
    const session = result.session;
    if (!detach) this.zmx.attach(session.zmxName);
    return session;
  }

  async list() {
    await this.ensureHealthy();
    return (await this.control.request("cli.list")).sessions;
  }

  async resolve(value) {
    await this.ensureHealthy();
    return (await this.control.request("cli.resolve", { value })).session;
  }

  async attach(value) {
    const session = await this.resolve(value);
    if (!session.managed || !session.zmxName) throw new Error("session cannot be attached from this terminal");
    this.zmx.attach(session.zmxName);
    return session;
  }

  async kill(value, force = false) {
    const session = await this.resolve(value);
    await this.control.request("cli.kill", { value: session.liveSessionId, force });
    return session;
  }

  async vaultResume(sessionFile, options = {}) {
    const path = resolve(sessionFile);
    const active = (await this.list()).find((session) => session.pi?.sessionFile === path);
    if (active) {
      if (!active.managed || !active.zmxName) throw new Error("matching Vault session is unmanaged and cannot be attached");
      this.zmx.attach(active.zmxName);
      return { attached: true, session: active };
    }
    return { attached: false, session: await this.create({ ...options, args: ["--session", path] }) };
  }

  async vaultFork(sessionFile, options = {}) {
    return this.create({ ...options, args: ["--fork", resolve(sessionFile)] });
  }

  async saveBaseline(environment = this.env) {
    await this.ensureHealthy();
    return this.control.request("cli.environment.save", { environment: stringEnvironment(environment) });
  }

  async status() { await this.ensureHealthy(); return this.control.request("cli.status"); }
  async addHost() { await this.ensureHealthy(); return this.control.request("cli.add-host"); }
  async doctor() { await this.ensureHealthy(); return this.control.request("cli.doctor"); }
}

function stringEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => key && typeof value === "string" && !key.includes("\0") && !value.includes("\0")));
}

function defaultKickstart() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  const result = spawnSync("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  return result.status === 0;
}
