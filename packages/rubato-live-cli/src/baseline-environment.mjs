import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultRemoteStateDirectory } from "./state-store.mjs";

export const BASELINE_EXCLUDED_KEYS = Object.freeze(new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM",
  "TERM_SESSION_ID",
  "ZMX_SESSION",
  "TMUX",
  "SSH_TTY",
  "CMUX_SOCKET_PATH",
  "__CFBundleIdentifier",
]));

export function baselineEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) =>
        !BASELINE_EXCLUDED_KEYS.has(key) && typeof value === "string" &&
        !key.includes("\0") && !value.includes("\0"))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function environmentHash(env) {
  return createHash("sha256").update(JSON.stringify(baselineEnvironment(env))).digest("hex");
}

export class MacKeychainKeyStore {
  constructor({ service = "com.keepitmello.rubato.remote.launch-env", account = process.env.USER ?? userInfo().username, spawn = spawnSync } = {}) {
    this.service = service;
    this.account = account;
    this.spawn = spawn;
  }

  get() {
    const result = this.spawn("/usr/bin/security", ["find-generic-password", "-a", this.account, "-s", this.service, "-w"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const key = Buffer.from(result.stdout.trim(), "base64");
    return key.length === 32 ? key : undefined;
  }

  set(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("baseline key must be 32 bytes");
    const result = this.spawn("/usr/bin/security", [
      "add-generic-password", "-U", "-a", this.account, "-s", this.service, "-w", key.toString("base64"),
    ], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`could not store Rubato baseline key: ${String(result.stderr).trim()}`);
  }

  getOrCreate() {
    const current = this.get();
    if (current) return current;
    const key = randomBytes(32);
    this.set(key);
    return key;
  }
}

export class BaselineEnvironmentStore {
  constructor({
    path = join(defaultRemoteStateDirectory(homedir()), "launch-env.enc"),
    keyStore = new MacKeychainKeyStore(),
  } = {}) {
    this.path = path;
    this.keyStore = keyStore;
  }

  save(env) {
    const payload = baselineEnvironment(env);
    const key = this.keyStore.getOrCreate();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const document = {
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      environmentHash: environmentHash(env),
      nonce: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(document) + "\n", { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    return document.environmentHash;
  }

  load() {
    let document;
    try {
      document = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (document.schemaVersion !== 1 || document.algorithm !== "AES-256-GCM") throw new Error("unsupported baseline environment format");
    const key = this.keyStore.get();
    if (!key) throw new Error("baseline environment key is missing from macOS Keychain");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(document.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(document.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(document.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  }

  refreshIfChanged(env) {
    try {
      const document = JSON.parse(readFileSync(this.path, "utf8"));
      if (document.environmentHash === environmentHash(env)) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    this.save(env);
    return true;
  }
}
