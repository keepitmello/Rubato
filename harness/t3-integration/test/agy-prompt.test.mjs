import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GENERATED_MARK, renderLeadAgent } from '../agy-lead.mjs';
import { installPromptAgent, savePrompt, readPrompt, verifyProfileAgent } from '../overlay/apps/server/src/provider/agyPrompt.mjs';

test('replacement body is verbatim; tool, sandbox and MCP settings match the lead', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-prompt-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  const body = '# Here\n\n`Agent` and team_create\n---\nnot: metadata';
  const agent = await installPromptAgent(home, body);
  const file = path.join(home, '.gemini/config/agents', `${agent}.md`);
  const actual = await readFile(file, 'utf8');
  const header = actual.slice(0, actual.indexOf('\n---\n'));
  assert.ok(header.includes(GENERATED_MARK));
  assert.equal(actual.slice(header.length + 5), body);
  const lead = (await renderLeadAgent()).split('\n---\n')[0];
  assert.equal(header.slice(header.indexOf('mainAgent:')), lead.slice(lead.indexOf('mainAgent:')));
  await verifyProfileAgent(home, path.join(home, '.gemini'), agent);
  await assert.rejects(verifyProfileAgent(home, path.join(home, 'unlinked'), agent));
  assert.equal(await installPromptAgent(home, body), agent);
  await writeFile(file, actual.replace('inheritMcp: true', 'inheritMcp: false'));
  assert.equal(await installPromptAgent(home, body), agent);
  assert.equal(await readFile(file, 'utf8'), actual);
  const mine = `---\nname: mine\n---\n# ${GENERATED_MARK}`;
  await writeFile(file, mine);
  await assert.rejects(installPromptAgent(home, body));
  assert.equal(await readFile(file, 'utf8'), mine);
});

test('prepare snapshots per app thread, independent of account; the badge never returns the body', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'agy-prompt-'));
  t.after(() => rm(state, {recursive:true, force:true}));
  const prompt = {text:'memo', label:'My prompt'};
  const summary = await savePrompt(state,'../thread', prompt);
  assert.equal(summary.text, undefined);
  assert.deepEqual(await savePrompt(state,'../thread', prompt), summary);
  assert.deepEqual(await readPrompt(state,'../thread'), {...summary, text:'memo'});
  assert.equal(await readPrompt(state,'other'), null);
  await assert.rejects(savePrompt(state,'../thread',{...prompt,text:'changed'}));
});
