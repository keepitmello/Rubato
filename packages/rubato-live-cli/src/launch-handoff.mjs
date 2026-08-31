import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, JsonFrameDecoder, REMOTE_PROTOCOL_NAME } from "./protocol-runtime.mjs";

const PROTOCOL = REMOTE_PROTOCOL_NAME;

export function quotePosix(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function bootstrapCommand({ nodePath, bootstrapPath, descriptorPath }) {
  return `exec ${quotePosix(nodePath)} ${quotePosix(bootstrapPath)} ${quotePosix(descriptorPath)}`;
}

function ownerOnly(path, kind) {
  const stat = statSync(path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${kind} is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${kind} permissions must be owner-only`);
  return stat;
}

function nextFrame(socket) {
  return new Promise((resolve, reject) => {
    const decoder = new JsonFrameDecoder();
    const onData = (chunk) => {
      try {
        const values = decoder.push(chunk);
        if (values.length === 0) return;
        cleanup();
        resolve(values[0]);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error("launch handoff ended before a complete response")); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

// Test/local port retained for dependency injection. Production launch tokens are
// issued and held by the hub's EnvironmentHandoffStore.
export class OneTimeLaunchBroker {
  constructor({ directory = join(tmpdir(), `rubato-remote-${typeof process.getuid === "function" ? process.getuid() : "user"}`), ttlMs = 60_000 } = {}) {
    this.directory = directory;
    this.ttlMs = ttlMs;
  }

  async prepare(payload) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const nonce = randomBytes(12).toString("hex");
    const token = randomBytes(32).toString("hex");
    const socketPath = join(this.directory, `l-${nonce}.sock`);
    const descriptorPath = join(this.directory, `d-${nonce}.json`);
    let settled = false;
    let resolveConsumed;
    let rejectConsumed;
    const consumed = new Promise((resolve, reject) => { resolveConsumed = resolve; rejectConsumed = reject; });
    const server = createServer((socket) => {
      void (async () => {
        try {
          const request = await nextFrame(socket);
          const supplied = Buffer.from(String(request?.token ?? ""), "hex");
          const expected = Buffer.from(token, "hex");
          if (settled || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            socket.end(encodeFrame({ kind: "hub.error", error: "unauthorized" }));
            return;
          }
          settled = true;
          socket.end(encodeFrame({ kind: "hub.launch", protocol: PROTOCOL, launch: payload }));
          resolveConsumed();
          server.close();
        } catch (error) {
          socket.destroy();
          if (!settled) { settled = true; rejectConsumed(error); server.close(); }
        }
      })();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    writeFileSync(descriptorPath, JSON.stringify({ schemaVersion: 1, socketPath, token }) + "\n", { mode: 0o600 });
    chmodSync(descriptorPath, 0o600);
    const cancel = (error = new Error("launch handoff cancelled")) => {
      if (!settled) { settled = true; rejectConsumed(error); }
      server.close();
      rmSync(socketPath, { force: true });
      rmSync(descriptorPath, { force: true });
    };
    const timer = setTimeout(() => cancel(new Error("launch handoff expired before bootstrap claimed it")), this.ttlMs);
    timer.unref?.();
    consumed.finally(() => {
      clearTimeout(timer);
      rmSync(socketPath, { force: true });
    }).catch(() => {});
    return { descriptorPath, consumed, cancel };
  }
}

export async function claimLaunchDescriptor(descriptorPath) {
  ownerOnly(descriptorPath, "launch descriptor");
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (descriptor.schemaVersion !== 1 || typeof descriptor.socketPath !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(descriptor.token)) {
    throw new Error("invalid launch descriptor");
  }
  ownerOnly(descriptor.socketPath, "hub socket");
  const socket = createConnection(descriptor.socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const responsePromise = nextFrame(socket);
  socket.write(encodeFrame({ kind: "bootstrap.claim", protocol: PROTOCOL, token: descriptor.token }));
  const response = await responsePromise;
  socket.destroy();
  if (response?.kind !== "hub.launch" || response.protocol !== PROTOCOL || !response.launch || typeof response.launch !== "object") throw new Error("launch handoff was rejected");
  rmSync(descriptorPath);
  return response.launch;
}
