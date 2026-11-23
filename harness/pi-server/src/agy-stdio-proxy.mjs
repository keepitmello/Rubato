import { createInterface } from 'node:readline';

// AGY's stdio child knows only its local capability, never how to find a Rubato session.
const url = new URL(process.env.RUBATO_SESSION_MCP_URL || '');
const authorization = process.env.RUBATO_SESSION_MCP_BEARER || '';
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' ||
    !authorization.startsWith('Bearer ')) throw new Error('Missing local Rubato MCP capability');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let id;
  try {
    id = JSON.parse(line)?.id;
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: line,
    });
    if (response.status === 202) continue;
    if (!response.ok) throw new Error('Rubato session MCP is unavailable');
    process.stdout.write(`${JSON.stringify(await response.json())}\n`);
  } catch {
    if (id !== undefined) process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id, error: { code: -32000, message: 'Rubato session MCP is unavailable' },
    })}\n`);
  }
}
