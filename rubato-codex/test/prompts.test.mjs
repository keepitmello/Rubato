import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('Rubato base keeps root leadership separate from delegated contracts', async () => {
  const base = await read('instructions/base.md');
  assert.match(base, /## Lead — main\/root session only/);
  assert.match(base, /does\s+not promote\s+it to lead/);
  assert.match(base, /Codex owns spawning/);
  assert.match(base, /define the\s+question and the relevant boundary before planning/);
  assert.match(base, /You see every workstream while each owner sees one/);
  assert.match(base, /Speak like a capable colleague sharing the screen/);
  assert.match(base, /take one independent review after local verification/);
  assert.doesNotMatch(base, /team_create|team_send|AgentSend|:8788|permissions pre-granted/);
  assert.match(base, /owners and verifiers are teammates, not\s+the lead's workers/);
  assert.match(base, /not make it the lead's subagent/);
  assert.match(base, /A subagent sits under whoever spawned it, lead or teammate/);
  assert.match(base, /single source for seats, parentage and spawn surface/);
  assert.doesNotMatch(base, /cognitively depth 0/);
  // Seat identity lives in base.md only; AGENTS.md and the role contracts do not restate it.
  const agentsMd = await read('instructions/AGENTS.md');
  assert.doesNotMatch(agentsMd, /not the lead's workers|cognitively depth 0/);
  const contracts = [];
  for (const role of ['owner', 'verifier', 'helper']) {
    const text = await read(`agents/taskforce_${role}.toml`);
    const instructions = JSON.parse(text.match(/^developer_instructions = (.+)$/m)[1]);
    assert.match(instructions, /inherited lead conversation does not make you the lead/);
    assert.match(instructions, /# Dispatched/);
    assert.doesNotMatch(instructions, /## Lead — main\/root session only/);
    contracts.push(instructions);
  }
  assert.equal(new Set(contracts).size, 3);
  assert.match(contracts[0], /You own one bounded outcome end to end/);
  assert.match(contracts[0], /Independent slices go out in one turn as subagents/);
  assert.match(contracts[0], /Keep diagnosis, integration, and anything with interpretation room/);
  assert.match(contracts[0], /Record what you spawned/);
  assert.doesNotMatch(contracts[0], /You can run helpers under yourself/);
  assert.match(contracts[1], /Your two falsification targets/);
  assert.match(contracts[2], /You are a subagent of the session that sent this brief — the lead or a teammate/);
  assert.match(contracts[2], /You are not on the team roster/);
  assert.match(contracts[2], /You do not own the wider workstream/);
  for (const text of contracts) {
    assert.doesNotMatch(text, /cognitively depth 0|not the lead's worker|Run this scope the way the lead runs the team|Do not do this outcome as a subagent of the lead/);
    assert.match(text, /defined by the base instructions' Role selection section/);
  }
});

test('native prompt replacement preserves Codex environment and distinct role layer', {
  skip: process.env.RUBATO_CODEX_NATIVE_E2E !== '1',
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rubato-codex-prompts-'));
  const codex = process.env.RUBATO_CODEX_TEST_BINARY || '/Applications/ChatGPT.app/Contents/Resources/codex';
  try {
    const basePath = join(home, 'base.md');
    await writeFile(basePath, await read('instructions/base.md'));
    await mkdir(join(home, 'agents'));
    for (const suffix of ['owner', 'verifier', 'helper']) {
      await writeFile(join(home, 'agents', `taskforce_${suffix}.toml`), await read(`agents/taskforce_${suffix}.toml`));
    }
    await writeFile(join(home, 'config.toml'), `model = "gpt-5.6-sol"\nmodel_instructions_file = ${JSON.stringify(basePath)}\n`);
    const inspect = (overrides = []) => {
      const result = spawnSync(codex, ['debug', 'prompt-input', ...overrides, 'Read-only prompt wiring inspection.'], {
        env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.stringify(JSON.parse(result.stdout));
    };
    const lead = inspect();
    assert.match(lead, /environment_context/);
    assert.doesNotMatch(lead, /Your two falsification targets/);
    const role = await read('agents/taskforce_owner.toml');
    const contract = JSON.parse(role.match(/^developer_instructions = (.+)$/m)[1]);
    const owner = inspect(['-c', `developer_instructions=${JSON.stringify(contract)}`]);
    assert.match(owner, /You own one bounded outcome end to end/);
    assert.match(owner, /environment_context/);
    // debug prompt-input omits the base. Capture the actual local-only request
    // instead of assuming a particular Responses wire representation.
    let request;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (part) => { body += part; });
      req.on('end', () => {
        if (body && req.url.includes('/responses')) request = JSON.parse(body);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Local prompt capture complete', type: 'invalid_request_error' } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/v1`;
      const args = ['exec', '--skip-git-repo-check', '-c', 'model_provider="prompt_capture"',
        '-c', 'model_providers.prompt_capture.name="Local prompt capture"',
        '-c', `model_providers.prompt_capture.base_url=${JSON.stringify(url)}`,
        '-c', 'model_providers.prompt_capture.wire_api="responses"',
        '-c', 'model_providers.prompt_capture.requires_openai_auth=false',
        '-c', 'model_providers.prompt_capture.request_max_retries=0',
        '-c', 'model_providers.prompt_capture.stream_max_retries=0',
        'Read-only local prompt transport probe.'];
      await new Promise((resolve, reject) => {
        const child = spawn(codex, args, { env: { ...process.env, CODEX_HOME: home }, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); reject(new Error('local prompt capture timed out')); }, 20000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      assert.ok(request, 'native Codex must send the request to the local capture endpoint');
      const base = (await read('instructions/base.md')).trim();
      const texts = request.input.flatMap((item) => item.content || []).map((part) => part.text || '');
      assert.ok(request.instructions?.trim() === base || texts.some((text) => text.trim() === base),
        'actual request must carry the exact replacement base');
      assert.match(JSON.stringify(request.input), /environment_context/);
      assert.ok(request.tools?.length > 0 || request.input.some((item) => item.type === 'additional_tools' && item.tools.length > 0),
        'native tools survive base replacement');
      const toolSchema = JSON.stringify(request.tools || request.input.filter((item) => item.type === 'additional_tools'));
      assert.match(toolSchema, /taskforce_owner/);
      assert.match(toolSchema, /taskforce_verifier/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // Role config parsing above is not actual agent_type selection.
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
