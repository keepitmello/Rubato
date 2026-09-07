import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  buildMcpToolNames,
  collectAllTools,
  convertJsonSchema,
  mapMcpToolResult,
  previewContent,
  toAgentContent,
} from "./compat.mjs";
import { isMcpSessionExpiredError, isRetriableMcpError } from "./errors.mjs";
import { applyMcpOutputGuard, McpOutputArtifacts } from "./output-guard.mjs";

const DEFAULT_CLIENT_INFO = Object.freeze({ name: "rubato-mcp", version: "0.1.0" });
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MIN = 10;
const DEFAULT_SEARCH_THRESHOLD = 10;
const PING_STALE_MS = 30_000;
const PING_TIMEOUT_MS = 2_000;

export class McpServiceError extends Error {
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = "McpServiceError";
    this.code = code;
    this.details = details;
  }
}

export function createMcpService(options) {
  return new McpService(options);
}

export class McpService {
  #agentDir;
  #clientInfo;
  #closePromise;
  #requestTimeoutMs;
  #outputArtifacts = new McpOutputArtifacts();
  #outputGuard;
  #searchThreshold;
  #servers;
  #serverStates = new Map();
  #startPromise;
  #state = "idle";
  #tools = [];
  #toolsByName = new Map();
  #warn;

  constructor({
    servers,
    clientInfo = DEFAULT_CLIENT_INFO,
    agentDir,
    outputGuard,
    requestTimeoutMs = 60_000,
    searchThreshold = DEFAULT_SEARCH_THRESHOLD,
    onWarning,
  } = {}) {
    this.#servers = validateServers(resolveServers(servers));
    this.#clientInfo = validateClientInfo(clientInfo);
    this.#agentDir = agentDir;
    this.#outputGuard = outputGuard;
    this.#requestTimeoutMs = validateTimeout(requestTimeoutMs, "requestTimeoutMs");
    this.#searchThreshold = validateNonNegativeNumber(searchThreshold, "searchThreshold");
    this.#warn = onWarning ?? ((message) => console.warn(`[rubato-mcp] ${message}`));
  }

  get state() {
    return this.#state;
  }

  get tools() {
    return this.#tools;
  }

  get servers() {
    return this.#servers;
  }

  get outputArtifacts() {
    return this.#outputArtifacts;
  }

  start() {
    if (this.#state === "started") return Promise.resolve(this.#tools);
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "idle") {
      return Promise.reject(
        new McpServiceError("MCP_SERVICE_NOT_STARTABLE", `Cannot start MCP service while it is ${this.#state}`),
      );
    }

    this.#state = "starting";
    this.#startPromise = this.#startImpl().then(
      (tools) => {
        this.#state = "started";
        return tools;
      },
      (error) => {
        this.#state = "failed";
        throw error;
      },
    );
    return this.#startPromise;
  }

  async callTool(proxyName, args = {}, { signal, onUpdate } = {}) {
    if (this.#state !== "started") {
      throw new McpServiceError(
        "MCP_SERVICE_NOT_STARTED",
        `Cannot call MCP tool '${proxyName}' while service is ${this.#state}`,
        { proxyName, state: this.#state },
      );
    }
    const entry = this.#toolsByName.get(proxyName);
    if (!entry) {
      throw new McpServiceError("MCP_TOOL_NOT_FOUND", `Unknown MCP proxy tool '${proxyName}'`, { proxyName });
    }

    const serverState = entry.serverState;
    clearIdleTimer(serverState);
    serverState.activeCalls += 1;
    const timeout = entry.requestTimeoutMs ?? this.#requestTimeoutMs;
    let result;
    try {
      result = await this.#withSessionExpiryRetry(serverState, signal, async () => {
        await this.#ensureHealthy(serverState, entry.connectTimeoutMs);
        return this.#withFailedSendRetry(serverState, signal, () => this.#performCall(
          entry,
          isRecord(args) ? args : {},
          { signal, timeout, onUpdate },
        ));
      });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
      }
      throw error;
    } finally {
      serverState.activeCalls -= 1;
      this.#scheduleIdleDisconnect(serverState);
    }

    const mapped = mapMcpToolResult(result);
    if (!mapped.ok) {
      throw new McpServiceError(
        "MCP_TOOL_RESULT_ERROR",
        mapped.message,
        { serverName: entry.serverName, toolName: entry.toolName, content: mapped.content },
      );
    }
    const guarded = await applyMcpOutputGuard(mapped.content, {
      agentDir: this.#agentDir,
      artifacts: this.#outputArtifacts,
      outputGuard: this.#outputGuard,
      server: entry.serverName,
    });
    const content = toAgentContent(guarded);
    return {
      content,
      details: { preview: previewContent(content), server: entry.serverName, tool: entry.toolName },
    };
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#closeImpl();
    return this.#closePromise;
  }

  async #startImpl() {
    const catalog = [];
    try {
      for (const server of this.#servers) {
        if (!server.enabled) continue;
        if (server.type !== "stdio") {
          throw new McpServiceError(
            "MCP_SERVER_TRANSPORT_UNSUPPORTED",
            `MCP server '${server.name}' uses unsupported transport '${server.type}'`,
            { serverName: server.name, type: server.type },
          );
        }
        if (server.exposure === "proxy") {
          throw new McpServiceError(
            "MCP_SERVER_EXPOSURE_UNSUPPORTED",
            `MCP server '${server.name}' requests unsupported proxy exposure`,
            { serverName: server.name, exposure: server.exposure },
          );
        }

        const serverState = {
          server,
          connection: undefined,
          connectPromise: undefined,
          activeCalls: 0,
          idleTimer: undefined,
          lastSuccessfulPingAtMs: undefined,
          pendingHealth: undefined,
        };
        this.#serverStates.set(server.name, serverState);

        try {
          const connection = await this.#ensureConnected(
            serverState,
            server.startupTimeoutMs ?? server.connectTimeoutMs,
          );
          const tools = await collectAllTools(
            connection.client,
            { timeout: server.startupTimeoutMs ?? server.requestTimeoutMs ?? this.#requestTimeoutMs },
            this.#warn,
            server.name,
          );
          const policy = computeMcpExposurePolicy(tools, server, this.#searchThreshold);
          for (const tool of policy.registeredTools) {
            catalog.push({
              server,
              serverState,
              tool,
              exposureMode: policy.mode,
              initiallyActive: policy.activeToolNames.has(tool.name),
            });
          }
          for (const warning of policy.warnings) this.#warn(warning);
          if (server.lifecycle === "lazy") await this.#disconnectServer(serverState);
        } catch (error) {
          if (error instanceof McpServiceError) throw error;
          throw new McpServiceError(
            "MCP_SERVER_START_FAILED",
            `MCP server '${server.name}' failed to initialize or list tools: ${errorLabel(error)}`,
            { serverName: server.name },
            { cause: error },
          );
        }
      }

      const sorted = catalog.sort(
        (left, right) =>
          left.server.name.localeCompare(right.server.name) || left.tool.name.localeCompare(right.tool.name),
      );
      rejectDuplicateCatalogEntries(sorted);
      const names = buildMcpToolNames(
        sorted.map(({ server, tool }) => ({ serverName: server.name, toolName: tool.name })),
        this.#warn,
      );

      this.#tools = Object.freeze(
        sorted.map(({ server, serverState, tool, exposureMode, initiallyActive }, index) => {
          const name = names[index];
          const label = `${server.name}/${tool.name}`;
          const parameters = convertJsonSchema(tool.inputSchema, this.#warn, label);
          const entry = {
            name,
            label,
            serverName: server.name,
            toolName: tool.name,
            requestTimeoutMs: server.requestTimeoutMs,
            connectTimeoutMs: server.connectTimeoutMs,
            serverState,
          };
          this.#toolsByName.set(name, entry);
          return Object.freeze({
            name,
            label,
            description: tool.description ?? `MCP tool ${label}`,
            parameters,
            mcpServerName: server.name,
            mcpToolName: tool.name,
            mcpExposure: exposureMode,
            mcpInitiallyActive: initiallyActive,
            executionMode: "parallel",
            execute: async (_toolCallId, params, signal, onUpdate) =>
              this.callTool(name, params, { signal, onUpdate }),
          });
        }),
      );
      return this.#tools;
    } catch (error) {
      await closeServerStates(this.#serverStates.values());
      this.#serverStates.clear();
      await this.#outputArtifacts.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async #ensureConnected(serverState, timeoutMs) {
    if (serverState.connection !== undefined) return serverState.connection;
    if (serverState.connectPromise !== undefined) return serverState.connectPromise;
    if (this.#state === "closing" || this.#state === "closed") {
      throw new McpServiceError("MCP_SERVICE_CLOSED", `MCP server '${serverState.server.name}' cannot reconnect after shutdown`);
    }

    const connect = this.#connect(serverState, timeoutMs);
    serverState.connectPromise = connect;
    try {
      return await connect;
    } finally {
      if (serverState.connectPromise === connect) serverState.connectPromise = undefined;
    }
  }

  async #connect(serverState, timeoutMs) {
    const { server } = serverState;
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
      stderr: server.stderr,
    });
    const client = new Client(this.#clientInfo, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: timeoutMs ?? this.#requestTimeoutMs });
      const connection = { client, transport };
      serverState.connection = connection;
      serverState.lastSuccessfulPingAtMs = Date.now();
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  #scheduleIdleDisconnect(serverState) {
    if (serverState.server.lifecycle !== "lazy" || serverState.activeCalls > 0 || this.#state !== "started") return;
    clearIdleTimer(serverState);
    const delay = (serverState.server.idleTimeoutMin ?? DEFAULT_IDLE_TIMEOUT_MIN) * 60_000;
    serverState.idleTimer = setTimeout(() => {
      serverState.idleTimer = undefined;
      if (serverState.activeCalls > 0 || this.#state !== "started") return;
      void this.#disconnectServer(serverState).catch((error) => {
        this.#warn(`MCP server '${serverState.server.name}' idle close failed: ${errorLabel(error)}`);
      });
    }, delay);
    serverState.idleTimer.unref?.();
  }

  async #performCall(entry, args, { signal, timeout, onUpdate }) {
    const connection = await this.#ensureConnected(entry.serverState, entry.connectTimeoutMs);
    return connection.client.callTool(
      { name: entry.toolName, arguments: args },
      undefined,
      {
        signal,
        timeout,
        onprogress: (progress) => {
          onUpdate?.({
            content: [{ type: "text", text: formatProgress(entry.label, progress) }],
            details: { progress, server: entry.serverName, tool: entry.toolName },
          });
        },
      },
    );
  }

  async #ensureHealthy(serverState, timeoutMs) {
    const connection = await this.#ensureConnected(serverState, timeoutMs);
    const lastPing = serverState.lastSuccessfulPingAtMs;
    if (lastPing !== undefined && Date.now() - lastPing <= PING_STALE_MS) return;
    if (serverState.pendingHealth !== undefined) return serverState.pendingHealth;
    const pending = connection.client.ping({ timeout: PING_TIMEOUT_MS }).then(
      () => { serverState.lastSuccessfulPingAtMs = Date.now(); },
      async () => { await this.#renewConnection(serverState, timeoutMs); },
    ).finally(() => {
      if (serverState.pendingHealth === pending) serverState.pendingHealth = undefined;
    });
    serverState.pendingHealth = pending;
    await pending;
  }

  async #withSessionExpiryRetry(serverState, signal, operation) {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || !isMcpSessionExpiredError(error)) throw error;
      await this.#renewConnection(serverState, serverState.server.connectTimeoutMs);
      try {
        return await operation();
      } catch (retryError) {
        if (!isMcpSessionExpiredError(retryError)) throw retryError;
        throw new McpServiceError(
          "MCP_SESSION_EXPIRED",
          `MCP server '${serverState.server.name}' session expired after one reconnect`,
          { serverName: serverState.server.name },
          { cause: retryError },
        );
      }
    }
  }

  async #withFailedSendRetry(serverState, signal, operation) {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || isMcpSessionExpiredError(error) || !isRetriableMcpError(error)) throw error;
      await this.#renewConnection(serverState, serverState.server.connectTimeoutMs);
      return operation();
    }
  }

  async #renewConnection(serverState, timeoutMs) {
    await this.#disconnectServer(serverState);
    return this.#ensureConnected(serverState, timeoutMs);
  }

  async #disconnectServer(serverState) {
    clearIdleTimer(serverState);
    if (serverState.connectPromise !== undefined) await serverState.connectPromise.catch(() => undefined);
    const connection = serverState.connection;
    serverState.connection = undefined;
    serverState.lastSuccessfulPingAtMs = undefined;
    if (connection !== undefined) await connection.client.close();
  }

  async #closeImpl() {
    if (this.#state === "closed") return;
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    this.#state = "closing";
    const errors = await closeServerStates(this.#serverStates.values());
    this.#serverStates.clear();
    try {
      await this.#outputArtifacts.cleanup();
    } catch (error) {
      errors.push(error);
    }
    this.#state = "closed";
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more MCP stdio clients failed to close");
    }
  }
}

export function computeMcpExposurePolicy(tools, server, searchThreshold = DEFAULT_SEARCH_THRESHOLD) {
  const filtered = [...tools]
    .filter((tool) => matchesAny(tool.name, server.includeTools, true))
    .filter((tool) => !matchesAny(tool.name, server.excludeTools, false))
    .sort((left, right) => left.name.localeCompare(right.name));
  const warnings = filtered.length === 0
    ? [`MCP server ${server.name} has 0 exposed tools after includeTools/excludeTools filters.`]
    : [];
  const direct = server.directTools === true
    ? filtered
    : filtered.filter((tool) => matchesAny(tool.name, server.directTools, false));
  const mode = server.directTools === true || server.exposure === "direct"
    ? "direct"
    : server.exposure === "search"
      ? "search"
      : filtered.length <= searchThreshold
        ? "direct"
        : "search";
  const active = mode === "direct" ? filtered : direct;
  return Object.freeze({
    mode,
    registeredTools: Object.freeze(filtered),
    activeToolNames: new Set(active.map(({ name }) => name)),
    warnings: Object.freeze(warnings),
  });
}

function resolveServers(servers) {
  if (typeof servers === "function") return servers();
  if (servers && typeof servers.list === "function") return servers.list();
  return servers;
}

function validateServers(servers) {
  if (!Array.isArray(servers)) {
    throw new TypeError("createMcpService requires a servers array, registry, or resolver");
  }
  const names = new Set();
  return Object.freeze(
    servers.map((server, index) => {
      if (!isRecord(server)) throw new TypeError(`servers[${index}] must be an object`);
      if (typeof server.name !== "string" || server.name.trim() === "") {
        throw new TypeError(`servers[${index}].name must be a non-empty string`);
      }
      if (names.has(server.name)) throw new TypeError(`MCP server names must be unique: '${server.name}'`);
      names.add(server.name);
      const enabled = server.enabled ?? true;
      if (typeof enabled !== "boolean") throw new TypeError(`servers[${index}].enabled must be boolean`);
      const type = server.type ?? (server.url ? "http" : "stdio");
      if (type !== "stdio" && type !== "http") throw new TypeError(`servers[${index}].type is invalid`);
      if (enabled && type === "stdio" && (typeof server.command !== "string" || server.command.trim() === "")) {
        throw new TypeError(`servers[${index}].command must be a non-empty string`);
      }
      if (server.args !== undefined && !isStringArray(server.args)) {
        throw new TypeError(`servers[${index}].args must be an array of strings`);
      }
      if (server.env !== undefined && !isStringRecord(server.env)) {
        throw new TypeError(`servers[${index}].env must contain only string values`);
      }
      const lifecycle = server.lifecycle ?? "lazy";
      if (!new Set(["lazy", "eager", "keep-alive"]).has(lifecycle)) {
        throw new TypeError(`servers[${index}].lifecycle is invalid`);
      }
      const exposure = server.exposure ?? "auto";
      if (!new Set(["auto", "direct", "search", "proxy"]).has(exposure)) {
        throw new TypeError(`servers[${index}].exposure is invalid`);
      }
      for (const key of ["includeTools", "excludeTools"]) {
        if (server[key] !== undefined && !isStringArray(server[key])) {
          throw new TypeError(`servers[${index}].${key} must be an array of strings`);
        }
      }
      if (server.directTools !== undefined && typeof server.directTools !== "boolean" && !isStringArray(server.directTools)) {
        throw new TypeError(`servers[${index}].directTools must be boolean or an array of strings`);
      }
      return Object.freeze({
        ...server,
        name: server.name,
        type,
        enabled,
        lifecycle,
        exposure,
        command: server.command,
        args: server.args ? [...server.args] : [],
        env: server.env ? { ...server.env } : undefined,
        includeTools: server.includeTools ? [...server.includeTools] : undefined,
        excludeTools: server.excludeTools ? [...server.excludeTools] : undefined,
        directTools: Array.isArray(server.directTools) ? [...server.directTools] : server.directTools,
        idleTimeoutMin:
          server.idleTimeoutMin === undefined
            ? DEFAULT_IDLE_TIMEOUT_MIN
            : validateNonNegativeNumber(server.idleTimeoutMin, `servers[${index}].idleTimeoutMin`),
        requestTimeoutMs:
          server.requestTimeoutMs === undefined
            ? undefined
            : validateTimeout(server.requestTimeoutMs, `servers[${index}].requestTimeoutMs`),
        connectTimeoutMs:
          server.connectTimeoutMs === undefined
            ? DEFAULT_CONNECT_TIMEOUT_MS
            : validateTimeout(server.connectTimeoutMs, `servers[${index}].connectTimeoutMs`),
        startupTimeoutMs:
          server.startupTimeoutMs === undefined
            ? undefined
            : validateTimeout(server.startupTimeoutMs, `servers[${index}].startupTimeoutMs`),
      });
    }),
  );
}

function validateClientInfo(clientInfo) {
  if (
    !isRecord(clientInfo) ||
    typeof clientInfo.name !== "string" ||
    clientInfo.name === "" ||
    typeof clientInfo.version !== "string" ||
    clientInfo.version === ""
  ) {
    throw new TypeError("clientInfo requires non-empty name and version strings");
  }
  return Object.freeze({ ...clientInfo });
}

function validateTimeout(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive number`);
  return value;
}

function validateNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number`);
  return value;
}

function rejectDuplicateCatalogEntries(catalog) {
  for (let index = 1; index < catalog.length; index += 1) {
    const previous = catalog[index - 1];
    const current = catalog[index];
    if (previous.server.name === current.server.name && previous.tool.name === current.tool.name) {
      throw new McpServiceError(
        "MCP_TOOL_DUPLICATE",
        `MCP server '${current.server.name}' listed duplicate tool '${current.tool.name}'`,
        { serverName: current.server.name, toolName: current.tool.name },
      );
    }
  }
}

async function closeServerStates(states) {
  const list = [...states];
  for (const state of list) clearIdleTimer(state);
  const settled = await Promise.allSettled(
    list.reverse().map(async (state) => {
      if (state.connectPromise !== undefined) await state.connectPromise.catch(() => undefined);
      const connection = state.connection;
      state.connection = undefined;
      if (connection !== undefined) await connection.client.close();
    }),
  );
  return settled.filter((item) => item.status === "rejected").map((item) => item.reason);
}

function clearIdleTimer(serverState) {
  if (serverState.idleTimer !== undefined) clearTimeout(serverState.idleTimer);
  serverState.idleTimer = undefined;
}

function matchesAny(value, patterns, whenEmpty) {
  if (!Array.isArray(patterns) || patterns.length === 0) return whenEmpty;
  return patterns.some((pattern) => globRegex(pattern).test(value));
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") index += 1;
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function formatProgress(label, progress) {
  const total = progress.total === undefined ? "" : `/${progress.total}`;
  const message = progress.message === undefined ? "" : ` ${progress.message}`;
  return `${label} progress ${progress.progress}${total}${message}`.trim();
}

function errorLabel(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
