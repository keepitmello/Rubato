import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** Include Rubato's lazily discoverable tools, not just this turn's loaded tools. */
export function listSessionMcpTools(session) {
  const callable = new Set(session.getCallableToolNames());
  return session.getAllTools().filter(tool => tool.exposure !== 'hidden' &&
    (callable.has(tool.name) || tool.exposure === 'search'));
}

// MCP-facing view of one live native session. The host supplies both capabilities;
// a client cannot select the session, its cwd, or a different tool executor.
export function createSessionMcpTools({ listTools, executeTool, signal, alwaysLoad = [] }) {
  if (typeof listTools !== 'function' || typeof executeTool !== 'function') {
    throw new TypeError('Session MCP needs a bound tool inventory and executor');
  }
  const denied = text => ({ isError: true, content: [{ type: 'text', text }] });
  function visibleTools() {
    return listTools().filter(tool => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) &&
      tool.parameters?.type === 'object');
  }
  return {
    list() {
      return visibleTools().map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(alwaysLoad.includes(tool.name) ? { _meta: { 'antigravity/alwaysLoad': true } } : {}),
      }));
    },
    async call(name, args = {}, options = {}) {
      const signals = [signal, options.signal].filter(Boolean);
      const activeSignal = signals.length === 2 ? AbortSignal.any(signals) : signals[0];
      activeSignal?.throwIfAborted();
      // Check current authority at execution time, not just during discovery.
      if (!visibleTools().some(tool => tool.name === name)) return denied('Tool not available in this session');
      if (!args || typeof args !== 'object' || Array.isArray(args)) return denied('Tool arguments must be an object');
      try {
        const result = await executeTool(name, args, { signal: activeSignal, activateInactiveTool: true });
        activeSignal?.throwIfAborted();
        return {
          content: result.content.map(item => {
            if (item.type === 'image') return { type: 'image', data: item.data, mimeType: item.mimeType };
            if (item.type === 'text') return { type: 'text', text: item.text };
            return { type: 'text', text: '[Unsupported tool result content]' };
          }),
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        activeSignal?.throwIfAborted();
        return denied(error instanceof Error ? error.message : 'Tool execution failed');
      }
    },
  };
}

export async function handleSessionMcpRequest({ id, method, params } = {}, tools) {
  const result = value => ({ jsonrpc: '2.0', id: id ?? null, result: value });
  switch (method) {
    case 'initialize':
      return result({ protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} }, serverInfo: { name: 'rubato-session', version: '1.0.0' } });
    case 'ping': return result({});
    case 'tools/list': return result({ tools: tools.list() });
    case 'tools/call': return result(await tools.call(params?.name, params?.arguments));
    default:
      if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
}

/**
 * Private streamable HTTP endpoint for a single provider turn. The credential exists only in
 * the launch-time MCP config. No caller-controlled name, cwd, or session ID selects authority.
 */
export async function openSessionMcpEndpoint({ listTools, executeTool, signal, alwaysLoad }) {
  signal?.throwIfAborted();
  const active = new AbortController();
  const tools = createSessionMcpTools({ listTools, executeTool, signal: active.signal, alwaysLoad });
  const token = `Bearer ${randomBytes(32).toString('base64url')}`;
  const expected = Buffer.from(token);
  const server = createServer(async (request, response) => {
    const status = (code) => { response.writeHead(code); response.end(); };
    const provided = Buffer.from(request.headers.authorization ?? '');
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return status(403);
    }
    if (request.url !== '/mcp') return status(404);
    if (request.method !== 'POST') return status(405);
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return status(415);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        if ((size += chunk.length) > 1024 * 1024) return status(413);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return status(400); }
      if (input?.jsonrpc !== '2.0' || typeof input.method !== 'string') return status(400);
      const result = await handleSessionMcpRequest(input, tools);
      if (result === undefined) return status(202);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch {
      status(active.signal.aborted ? 410 : 500);
    }
  });
  const close = () => {
    signal?.removeEventListener('abort', close);
    active.abort();
    server.close();
    server.closeAllConnections();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) {
    close();
    signal.throwIfAborted();
  }
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: [{ name: 'Authorization', value: token }],
    close,
  };
}
