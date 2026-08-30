import { createServer } from "node:http";

function writeText(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({
      id: "cmpl-stub",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: "cmpl-stub",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeToolCall(res, { name, args, id = "call_1" }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({
      id: "cmpl-stub",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
        },
      }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: "cmpl-stub",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
      }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: "cmpl-stub",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

export function startMockOpenAI({ reply = "ok", onRequest } = {}) {
  const hanging = [];
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stub", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      requests.push({ method: req.method, url: req.url, toolNames: (body.tools ?? []).map((t) => t.function?.name ?? t.name) });
      const action = onRequest ? onRequest(body) : { type: "text", text: reply };
      if (action?.type === "hang") {
        hanging.push(res);
        return;
      }
      if (action?.type === "tool") {
        writeToolCall(res, action);
        return;
      }
      writeText(res, action?.text ?? reply);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => {
          for (const res of hanging) {
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          }
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
