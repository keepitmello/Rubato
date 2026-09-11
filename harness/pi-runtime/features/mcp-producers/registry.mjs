import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const EXPOSURES = new Set(["auto", "direct", "search", "proxy"]);
const LIFECYCLES = new Set(["lazy", "eager", "keep-alive"]);
const TRANSPORTS = new Set(["stdio", "http"]);
const SERVER_KEYS = new Set([
  "args",
  "auth",
  "bearerTokenEnv",
  "command",
  "connectTimeoutMs",
  "cwd",
  "directTools",
  "enabled",
  "env",
  "excludeTools",
  "exposure",
  "headers",
  "idleTimeoutMin",
  "includeTools",
  "lifecycle",
  "logLevel",
  "oauth",
  "requestTimeoutMs",
  "startupTimeoutMs",
  "type",
  "url",
]);

export class McpProducerError extends Error {
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = "McpProducerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Session-loader-scoped registry for Rubato's existing registerMcpServer
 * producers. It is intentionally outside stock Pi: the wrapper supplies the
 * one API those producers need and the MCP extension consumes list().
 */
export class McpProducerRegistry {
  #declarations = new Map();
  #defaultRegistrationCwd;
  #generation = 0;
  #validateRequiredAsset;

  constructor({ registrationCwd = process.cwd(), validateRequiredAsset = validateNodeEntryAsset } = {}) {
    this.#defaultRegistrationCwd = requireNonEmptyString(registrationCwd, "registrationCwd");
    if (typeof validateRequiredAsset !== "function") {
      throw new TypeError("validateRequiredAsset must be a function");
    }
    this.#validateRequiredAsset = validateRequiredAsset;
  }

  registerMcpServer(name, config, metadata = {}) {
    const ownerId = metadata.ownerId ?? metadata.sourcePath ?? "<anonymous-mcp-producer>";
    const registrationCwd = metadata.registrationCwd ?? this.#defaultRegistrationCwd;
    const normalized = normalizeMcpServerDeclaration(name, config, { registrationCwd, sourcePath: metadata.sourcePath });
    this.#validateRequiredAsset(normalized);

    const existing = this.#declarations.get(normalized.name);
    if (existing !== undefined) {
      throw new McpProducerError(
        "MCP_SERVER_DUPLICATE",
        `MCP server '${normalized.name}' was registered by both '${existing.ownerId}' and '${ownerId}'`,
        { name: normalized.name, firstOwner: existing.ownerId, secondOwner: ownerId },
      );
    }
    const declaration = Object.freeze({ ...normalized, ownerId, generation: this.#generation });
    this.#declarations.set(declaration.name, declaration);
    return declaration;
  }

  list() {
    return Object.freeze(
      [...this.#declarations.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ ownerId: _ownerId, generation: _generation, ...server }) => Object.freeze({ ...server })),
    );
  }

  createExtensionApi(pi, metadata = {}) {
    if ((typeof pi !== "object" && typeof pi !== "function") || pi === null) {
      throw new TypeError("MCP producer wrapper requires a Pi ExtensionAPI object");
    }
    const register = (name, config) => this.registerMcpServer(name, config, metadata);
    return new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerMcpServer") return register;
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        return property === "registerMcpServer" || Reflect.has(target, property);
      },
    });
  }

  wrapFactory(factory, metadata = {}) {
    if (typeof factory !== "function") throw new TypeError("MCP producer factory must be a function");
    const ownerId = metadata.ownerId ?? metadata.sourcePath ?? factory.name ?? "<anonymous-mcp-producer>";
    return async (pi) => {
      this.#beginOwner(ownerId);
      try {
        return await factory(this.createExtensionApi(pi, { ...metadata, ownerId }));
      } catch (error) {
        this.#deleteOwner(ownerId);
        throw error;
      }
    };
  }

  #beginOwner(ownerId) {
    this.#generation += 1;
    this.#deleteOwner(ownerId);
  }

  #deleteOwner(ownerId) {
    for (const [name, declaration] of this.#declarations) {
      if (declaration.ownerId === ownerId) this.#declarations.delete(name);
    }
  }
}

export function createMcpProducerRegistry(options) {
  return new McpProducerRegistry(options);
}

export function wrapMcpProducerFactory(factory, registry, metadata) {
  if (!(registry instanceof McpProducerRegistry)) {
    throw new TypeError("wrapMcpProducerFactory requires an McpProducerRegistry");
  }
  return registry.wrapFactory(factory, metadata);
}

export function normalizeMcpServerDeclaration(name, raw, { registrationCwd = process.cwd(), sourcePath } = {}) {
  const normalizedName = requireNonEmptyString(name, "MCP server name");
  if (!isRecord(raw)) {
    throw new McpProducerError("MCP_SERVER_INVALID", `Invalid MCP server declaration '${normalizedName}': config must be an object`);
  }
  const unknown = Object.keys(raw).filter((key) => !SERVER_KEYS.has(key));
  if (unknown.length > 0) {
    throw new McpProducerError(
      "MCP_SERVER_INVALID",
      `Invalid MCP server declaration '${normalizedName}': unknown field '${unknown.sort()[0]}'`,
      { name: normalizedName, field: unknown.sort()[0] },
    );
  }

  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") invalid(normalizedName, "enabled must be boolean");
  const type = raw.type ?? (raw.url ? "http" : "stdio");
  if (!TRANSPORTS.has(type)) invalid(normalizedName, "type must be 'stdio' or 'http'");
  const lifecycle = raw.lifecycle ?? "lazy";
  if (!LIFECYCLES.has(lifecycle)) invalid(normalizedName, "lifecycle must be 'lazy', 'eager', or 'keep-alive'");
  const exposure = raw.exposure ?? "auto";
  if (!EXPOSURES.has(exposure)) invalid(normalizedName, "exposure must be 'auto', 'direct', 'search', or 'proxy'");

  if (raw.args !== undefined && !isStringArray(raw.args)) invalid(normalizedName, "args must be an array of strings");
  if (raw.env !== undefined && !isStringRecord(raw.env)) invalid(normalizedName, "env must contain only string values");
  if (raw.headers !== undefined && !isStringRecord(raw.headers)) invalid(normalizedName, "headers must contain only string values");
  for (const key of ["includeTools", "excludeTools"]) {
    if (raw[key] !== undefined && !isStringArray(raw[key])) invalid(normalizedName, `${key} must be an array of strings`);
  }
  if (raw.directTools !== undefined && typeof raw.directTools !== "boolean" && !isStringArray(raw.directTools)) {
    invalid(normalizedName, "directTools must be boolean or an array of strings");
  }
  for (const key of ["connectTimeoutMs", "requestTimeoutMs", "startupTimeoutMs"]) {
    if (raw[key] !== undefined) validatePositiveNumber(raw[key], normalizedName, key);
  }
  if (raw.idleTimeoutMin !== undefined && (!Number.isFinite(raw.idleTimeoutMin) || raw.idleTimeoutMin < 0)) {
    invalid(normalizedName, "idleTimeoutMin must be a non-negative number");
  }

  const cwd = raw.cwd === undefined ? registrationCwd : requireNonEmptyString(raw.cwd, "cwd");
  if (enabled && type === "stdio" && (typeof raw.command !== "string" || raw.command.trim() === "")) {
    invalid(normalizedName, "command is required for an enabled stdio server");
  }
  if (enabled && type === "http" && (typeof raw.url !== "string" || raw.url.trim() === "")) {
    invalid(normalizedName, "url is required for an enabled http server");
  }

  return Object.freeze({
    ...raw,
    name: normalizedName,
    type,
    enabled,
    lifecycle,
    exposure,
    args: raw.args ? Object.freeze([...raw.args]) : Object.freeze([]),
    env: raw.env ? Object.freeze({ ...raw.env }) : undefined,
    headers: raw.headers ? Object.freeze({ ...raw.headers }) : undefined,
    cwd,
    registrationCwd,
    sourcePath,
  });
}

/** Validate the concrete entry used by Rubato's Node-backed MCP producers. */
export function validateNodeEntryAsset(server) {
  if (!server.enabled || server.type !== "stdio" || !looksLikeNode(server.command)) return;
  const entry = server.args[0];
  if (typeof entry !== "string" || entry.startsWith("-")) return;
  const path = isAbsolute(entry) ? entry : resolve(server.cwd, entry);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat?.isFile()) return;
  throw new McpProducerError(
    "MCP_SERVER_ENTRY_MISSING",
    `MCP server '${server.name}' requires a missing Node entry: ${path}`,
    { name: server.name, path },
  );
}

function looksLikeNode(command) {
  const name = basename(command).toLowerCase();
  return name === "node" || name === "node.exe" || /^node\d+(?:\.\d+)*$/.test(name);
}

function validatePositiveNumber(value, name, key) {
  if (!Number.isFinite(value) || value <= 0) invalid(name, `${key} must be a positive number`);
}

function invalid(name, message) {
  throw new McpProducerError("MCP_SERVER_INVALID", `Invalid MCP server declaration '${name}': ${message}`, { name });
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
