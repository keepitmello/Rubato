import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_MARK, LEAD_AGENT, LEAD_INSTANCE_ID, RUBATO_ONLY, agyHome, findAgy, installLeadAgent, leadInstance, renderLeadAgent,
} from '../agy-lead.mjs';

const writer = fileURLToPath(new URL('../write-gui-settings.mjs', import.meta.url));
const scratch = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-agy-lead-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const fakeAgy = (directory) => {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'agy');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
};
const agentFile = (home, name = LEAD_AGENT) => path.join(home, '.gemini', 'config', 'agents', `${name}.md`);

test('the lead agent comes from the canonical lead prompt, without tools agy does not have', async () => {
  const text = await renderLeadAgent();
  assert.match(text, new RegExp(`^---\\nname: ${LEAD_AGENT}\\n[\\s\\S]*?mainAgent: true\\n[\\s\\S]*?\\n---\\n\\n`));
  assert.ok(text.includes(GENERATED_MARK));
  assert.doesNotMatch(text, RUBATO_ONLY);
  const prompts = fileURLToPath(new URL('../../prompts/', import.meta.url));
  const lead = readFileSync(path.join(prompts, 'core-lead.pi.md'), 'utf8');
  assert.ok(text.includes(lead.split('\n\n')[1].trim()), 'carries the canonical lead role');
  assert.ok(text.includes('I run inside the official agy CLI.'));
  const voice = readFileSync(path.join(prompts, 'voice.md'), 'utf8').trim();
  assert.ok(text.trimEnd().endsWith(voice), 'the voice stays last, as in the canonical build');
});

test('the agent file is ours only while it carries the generated mark', async (t) => {
  const home = scratch(t);
  assert.equal(await installLeadAgent(home), 'written');
  assert.equal(readFileSync(agentFile(home), 'utf8'), await renderLeadAgent());
  assert.equal(await installLeadAgent(home), 'unchanged');
  writeFileSync(agentFile(home, 'my-agent'), 'mine\n');
  writeFileSync(agentFile(home), '---\nname: rubato-lead\n---\nmy own lead\n');
  assert.equal(await installLeadAgent(home), 'kept');
  assert.equal(readFileSync(agentFile(home), 'utf8'), '---\nname: rubato-lead\n---\nmy own lead\n');
  assert.equal(readFileSync(agentFile(home, 'my-agent'), 'utf8'), 'mine\n');
});

test('agy is found on PATH, then in ~/.local/bin, and only as an executable', async (t) => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  assert.equal(await findAgy({ PATH: path.join(root, 'none'), HOME: home }), null);
  const local = fakeAgy(path.join(home, '.local', 'bin'));
  assert.equal(await findAgy({ PATH: '/usr/bin', HOME: home }), local);
  const onPath = fakeAgy(path.join(root, 'bin'));
  assert.equal(await findAgy({ PATH: `relative:${path.join(root, 'bin')}`, HOME: home }), onPath);
  chmodSync(onPath, 0o644);
  assert.equal(await findAgy({ PATH: path.join(root, 'bin'), HOME: home }), local);
});

const runWriter = (env) => {
  const result = spawnSync(process.execPath, [writer], { encoding: 'utf8', env: {
    RUBATO_GUI_BRIDGE: '/repo/bridge.mjs', RUBATO_GUI_DESCRIPTOR: '/agent/connection.json', RUBATO_GUI_CATALOGUE: '/home',
    ...env,
  } });
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const readSettings = (t3Home) => JSON.parse(readFileSync(path.join(t3Home, 'userdata', 'settings.json'), 'utf8'));
const writeSettings = (t3Home, settings) => {
  mkdirSync(path.join(t3Home, 'userdata'), { recursive: true });
  writeFileSync(path.join(t3Home, 'userdata', 'settings.json'), JSON.stringify(settings));
};

test('the installer offers the lead once when agy is present and leaves other instances alone', { skip: process.platform === 'win32' }, async (t) => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const t3Home = path.join(home, '.rubato', 't3-home');
  const agy = fakeAgy(path.join(root, 'bin'));
  const mine = {
    driver: 'antigravity', displayName: 'Mine', enabled: true,
    environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'my-agent', sensitive: false }],
    config: { authMethod: 'oauth-personal', binaryPath: agy },
  };
  writeSettings(t3Home, { providerInstances: { 'agy-mine': mine } });
  mkdirSync(path.dirname(agentFile(home)), { recursive: true });
  writeFileSync(agentFile(home, 'my-agent'), 'mine\n');
  const env = { HOME: home, PATH: path.join(root, 'bin'), RUBATO_GUI_T3_HOME: t3Home };

  runWriter(env);
  let instances = readSettings(t3Home).providerInstances;
  assert.deepEqual(instances[LEAD_INSTANCE_ID], leadInstance(agy));
  assert.deepEqual(instances['agy-mine'], mine);
  assert.equal(readFileSync(agentFile(home), 'utf8'), await renderLeadAgent());
  assert.equal(readFileSync(agentFile(home, 'my-agent'), 'utf8'), 'mine\n');

  // Removed by the user: an update does not bring it back.
  const settings = readSettings(t3Home);
  delete settings.providerInstances[LEAD_INSTANCE_ID];
  writeSettings(t3Home, settings);
  runWriter(env);
  instances = readSettings(t3Home).providerInstances;
  assert.equal(instances[LEAD_INSTANCE_ID], undefined);
  assert.deepEqual(instances['agy-mine'], mine);
});

test('an existing lead instance is never overwritten', { skip: process.platform === 'win32' }, (t) => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const t3Home = path.join(home, '.rubato', 't3-home');
  fakeAgy(path.join(root, 'bin'));
  const custom = { ...leadInstance('/opt/agy'), displayName: 'My lead', enabled: false };
  writeSettings(t3Home, { providerInstances: { [LEAD_INSTANCE_ID]: custom } });
  runWriter({ HOME: home, PATH: path.join(root, 'bin'), RUBATO_GUI_T3_HOME: t3Home });
  assert.deepEqual(readSettings(t3Home).providerInstances[LEAD_INSTANCE_ID], custom);
});

test('without agy, or for a T3 home outside HOME, nothing agy-related is written', { skip: process.platform === 'win32' }, (t) => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const t3Home = path.join(home, '.rubato', 't3-home');
  runWriter({ HOME: home, PATH: path.join(root, 'none'), RUBATO_GUI_T3_HOME: t3Home });
  assert.equal(readSettings(t3Home).providerInstances[LEAD_INSTANCE_ID], undefined);
  assert.equal(existsSync(path.join(home, '.gemini')), false);

  fakeAgy(path.join(home, '.local', 'bin'));
  const elsewhere = path.join(root, 'other-t3-home');
  runWriter({ HOME: home, PATH: path.join(root, 'none'), RUBATO_GUI_T3_HOME: elsewhere });
  assert.equal(readSettings(elsewhere).providerInstances[LEAD_INSTANCE_ID], undefined);
  assert.equal(existsSync(path.join(home, '.gemini')), false);
});

test('on Windows agy.exe is found through Path (any case, ";"-separated) or USERPROFILE', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'agy'), '');
  writeFileSync(path.join(bin, 'agy.cmd'), '');
  // A shim without the .exe is not spawnable without a shell, so it is not taken.
  assert.equal(await findAgy({ Path: `relative;${bin}` }, 'win32'), null);
  writeFileSync(path.join(bin, 'agy.exe'), '');
  assert.equal(await findAgy({ Path: `relative;${bin}` }, 'win32'), path.join(bin, 'agy.exe'));
  const profile = path.join(root, 'profile');
  mkdirSync(path.join(profile, '.local', 'bin'), { recursive: true });
  writeFileSync(path.join(profile, '.local', 'bin', 'agy.exe'), '');
  assert.equal(await findAgy({ PATH: '', USERPROFILE: profile }, 'win32'), path.join(profile, '.local', 'bin', 'agy.exe'));
  assert.equal(agyHome({ USERPROFILE: profile }, 'win32'), profile);
  assert.equal(agyHome({ USERPROFILE: profile }, 'darwin'), undefined);
});
