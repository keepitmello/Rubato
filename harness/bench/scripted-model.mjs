// The model a bench talks to: an OpenAI-compatible chat endpoint on loopback that answers from a
// script, so a measured turn costs no quota, takes no network time and comes out the same each run.
// The aged profile's models.json points its only provider (`bench`) here (aged-profile.mjs).
//
//   a request whose last message is the person's, with tools offered  → one tool call
//   the person's message carries WINDOW_CHANGE                        → save now.md, then new_context
//   anything else (a tool's result came back, a summary was asked)  → a reply of `replyChars`
//                                                                       streamed in `chunks` parts
import { createServer } from 'node:http';

const TEXT = '측정용 답이야. The engine streams this reply in parts, like a model would. ';

/** A prompt carrying this asks for a context-window change (the notes mode's compaction). */
export const WINDOW_CHANGE = '[bench:new_context]';

const textOf = (message) => (typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? '').join('') : '');

function toolCall(messages, tools) {
  const names = new Set((tools ?? []).map((tool) => tool?.function?.name));
  const userAt = messages.findLastIndex((message) => message?.role === 'user');
  const calls = messages.slice(userAt + 1).filter((message) => message?.role === 'assistant' && message.tool_calls?.length).length;
  if (textOf(messages[userAt]).includes(WINDOW_CHANGE)) {
    if (calls === 0 && names.has('notes_write_file')) return { name: 'notes_write_file', arguments: { path: 'now.md', text: '# now\nbench checkpoint\n' } };
    if (calls === 1 && names.has('new_context')) return { name: 'new_context', arguments: {} };
    return undefined;
  }
  if (calls > 0 || messages.at(-1)?.role !== 'user') return undefined;
  if (names.has('bash')) return { name: 'bash', arguments: { command: 'echo bench' } };
  if (names.has('read')) return { name: 'read', arguments: { path: 'README.md' } };
  return undefined;
}

/** Starts the server. Resolves to `{ port, requests, close() }`; `requests` counts what it answered. */
export async function startScriptedModel({ port = 0, replyChars = 2000, chunks = 200 } = {}) {
  const stats = { requests: 0, toolCalls: 0, replies: 0 };
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      stats.requests += 1;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const call = toolCall(parsed.messages ?? [], parsed.tools);
      const id = `chatcmpl-bench-${stats.requests}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'scripted',
        choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(chunk({ role: 'assistant', content: '' }));
      if (call) {
        stats.toolCalls += 1;
        response.write(chunk({ tool_calls: [{ index: 0, id: `call_bench_${stats.requests}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
        response.write(chunk({}, 'tool_calls'));
      } else {
        stats.replies += 1;
        const text = TEXT.repeat(Math.ceil(replyChars / TEXT.length)).slice(0, replyChars);
        const size = Math.ceil(text.length / chunks);
        for (let at = 0; at < text.length; at += size) response.write(chunk({ content: text.slice(at, at + size) }));
        response.write(chunk({}, 'stop'));
      }
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'scripted', choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, stats, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

if (process.argv[1] && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ options: { port: { type: 'string' } } });
  const model = await startScriptedModel({ port: Number(values.port ?? 47811) });
  console.log(`scripted model on http://127.0.0.1:${model.port}/v1`);
}
