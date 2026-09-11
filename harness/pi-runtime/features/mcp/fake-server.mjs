import { appendFileSync, existsSync, writeFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const markerPath = process.env.RUBATO_MCP_TEST_MARKER ?? process.env.RUBATO_AST_GREP_PROJECT_CWD;
const retryStatePath = process.env.RUBATO_MCP_TEST_RETRY_STATE;
const exposeLarge = process.env.RUBATO_MCP_TEST_LARGE === "1";
const exposeRetry = retryStatePath !== undefined;
const mark = (value) => {
  if (markerPath) appendFileSync(markerPath, `${value}\n`);
};

const echoSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  additionalProperties: false,
  $defs: { value: { type: "string" } },
};

const server = new Server(
  { name: "rubato-mcp-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.oninitialized = () => mark("initialized");

server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
  mark(`list:${params?.cursor ?? "first"}`);
  if (!params?.cursor) {
    return {
      tools: [
        { name: "echo", description: "Echo a string", inputSchema: echoSchema },
        { name: "error", description: "Return an MCP error result", inputSchema: { type: "object" } },
      ],
      nextCursor: "page-2",
    };
  }
  return {
    tools: [
      { name: "rich", description: "Return non-text MCP blocks", inputSchema: { type: "object" } },
      { name: "slow", description: "Wait until cancelled", inputSchema: { type: "object" } },
      ...(exposeLarge ? [{ name: "large", description: "Return oversized output", inputSchema: { type: "object" } }] : []),
      ...(exposeRetry ? [{ name: "retry", description: "Expire once, then succeed", inputSchema: { type: "object" } }] : []),
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  mark(`call:${request.params.name}`);
  // The SDK exposes request metadata through RequestHandlerExtra. Reading the
  // parsed method params is not stable because schema parsing may strip _meta.
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: 1, total: 1, message: "working" },
    });
  }

  switch (request.params.name) {
    case "echo":
      return {
        content: [{ type: "text", text: `echo:${request.params.arguments?.value}` }],
        structuredContent: { echoed: request.params.arguments?.value },
      };
    case "error":
      return { content: [{ type: "text", text: "fixture failure" }], isError: true };
    case "rich":
      return {
        content: [
          { type: "audio", data: "AA==", mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///fixture.txt", name: "fixture" },
        ],
      };
    case "slow":
      return await new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ content: [{ type: "text", text: "too late" }] }),
          10_000,
        );
        extra.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            mark("cancelled:slow");
            resolve({ content: [{ type: "text", text: "cancelled" }], isError: true });
          },
          { once: true },
        );
      });
    case "large":
      return { content: [{ type: "text", text: Array.from({ length: 100 }, (_, index) => `large-line-${index}`).join("\n") }] };
    case "retry":
      if (!existsSync(retryStatePath)) {
        writeFileSync(retryStatePath, "expired\n", "utf8");
        throw new McpError(-32001, "session expired");
      }
      return { content: [{ type: "text", text: "retry:ok" }] };
    default:
      return { content: [{ type: "text", text: "unknown tool" }], isError: true };
  }
});

process.once("exit", () => mark("exit"));
await server.connect(new StdioServerTransport());
