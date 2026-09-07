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

const DEFAULT_CLIENT_INFO = Object.freeze({ name: "rubato-mcp", version: "0.1.0" });

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
  #clientInfo;
  #connections = [];
  #closePromise;
  #requestTimeoutMs;
  #servers;
  #startPromise;
  #state = "idle";
  #tools = [];
  #toolsByName = new Map();
  #warn;

  constructor({ servers, clientInfo = DEFAULT_CLIENT_INFO, requestTimeoutMs = 60_000, onWarning } = {}) {
    this.#servers = validateServers(servers);
    this.#clientInfo = validateClientInfo(clientInfo);
    this.#requestTimeoutMs = validateTimeout(requestTimeoutMs, "requestTimeoutMs");
    this.#warn = onWarning ?? ((message) => console.warn(`[rubato-mcp] ${message}`));
  }

  get state() {
    return this.#state;
  }

  get tools() {
    return this.#tools;
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

    const timeout = entry.requestTimeoutMs ?? this.#requestTimeoutMs;
    let result;
    try {
      result = await entry.client.callTool(
        { name: entry.toolName, arguments: isRecord(args) ? args : {} },
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
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
      }
      throw error;
    }

    const mapped = mapMcpToolResult(result);
    if (!mapped.ok) {
      throw new McpServiceError(
        "MCP_TOOL_RESULT_ERROR",
        mapped.message,
        { serverName: entry.serverName, toolName: entry.toolName, content: mapped.content },
      );
    }
    const content = toAgentContent(mapped.content);
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
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: server.env ? { ...getDefaultEnvironment(), ...server.env } : undefined,
          stderr: server.stderr,
        });
        const client = new Client(this.#clientInfo, { capabilities: {} });
        const connection = { server, client, transport };
        this.#connections.push(connection);

        try {
          await client.connect(transport, { timeout: server.requestTimeoutMs ?? this.#requestTimeoutMs });
          const tools = await collectAllTools(
            client,
            { timeout: server.requestTimeoutMs ?? this.#requestTimeoutMs },
            this.#warn,
            server.name,
          );
          for (const tool of tools) {
            catalog.push({ server, client, tool });
          }
        } catch (error) {
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
        sorted.map(({ server, client, tool }, index) => {
          const name = names[index];
          const label = `${server.name}/${tool.name}`;
          const parameters = convertJsonSchema(tool.inputSchema, this.#warn, label);
          const entry = {
            name,
            label,
            serverName: server.name,
            toolName: tool.name,
            requestTimeoutMs: server.requestTimeoutMs,
            client,
          };
          this.#toolsByName.set(name, entry);
          return Object.freeze({
            name,
            label,
            description: tool.description ?? `MCP tool ${label}`,
            parameters,
            executionMode: "parallel",
            execute: async (_toolCallId, params, signal, onUpdate) =>
              this.callTool(name, params, { signal, onUpdate }),
          });
        }),
      );
      return this.#tools;
    } catch (error) {
      await closeConnections(this.#connections);
      this.#connections = [];
      throw error;
    }
  }

  async #closeImpl() {
    if (this.#state === "closed") return;
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    this.#state = "closing";
    const errors = await closeConnections(this.#connections);
    this.#connections = [];
    this.#state = "closed";
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more MCP stdio clients failed to close");
    }
  }
}

function validateServers(servers) {
  if (!Array.isArray(servers)) {
    throw new TypeError("createMcpService requires a servers array");
  }
  const names = new Set();
  return Object.freeze(
    servers.map((server, index) => {
      if (!isRecord(server)) throw new TypeError(`servers[${index}] must be an object`);
      if (server.type !== "stdio") throw new TypeError(`servers[${index}].type must be 'stdio'`);
      if (typeof server.name !== "string" || server.name.trim() === "") {
        throw new TypeError(`servers[${index}].name must be a non-empty string`);
      }
      if (names.has(server.name)) throw new TypeError(`MCP server names must be unique: '${server.name}'`);
      names.add(server.name);
      if (typeof server.command !== "string" || server.command.trim() === "") {
        throw new TypeError(`servers[${index}].command must be a non-empty string`);
      }
      if (server.args !== undefined && !isStringArray(server.args)) {
        throw new TypeError(`servers[${index}].args must be an array of strings`);
      }
      if (server.env !== undefined && !isStringRecord(server.env)) {
        throw new TypeError(`servers[${index}].env must contain only string values`);
      }
      return Object.freeze({
        ...server,
        name: server.name,
        type: "stdio",
        command: server.command,
        args: server.args ? [...server.args] : undefined,
        env: server.env ? { ...server.env } : undefined,
        requestTimeoutMs:
          server.requestTimeoutMs === undefined
            ? undefined
            : validateTimeout(server.requestTimeoutMs, `servers[${index}].requestTimeoutMs`),
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

async function closeConnections(connections) {
  const settled = await Promise.allSettled(
    [...connections].reverse().map(({ client }) => client.close()),
  );
  return settled.filter((item) => item.status === "rejected").map((item) => item.reason);
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
