import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hasLocalAgyAgent,
  linkLocalAgyProfileConfig,
  localAgyAgent,
  localAgyIsolated,
  localAgyModels,
  localAgySpawn,
  localAgyWithAgentArgs,
} from '../overlay/apps/server/src/provider/RubatoLocalAgy.ts';

test('local agy is opt-in and uses only the native agent selector', () => {
  assert.equal(localAgyAgent([]), undefined);
  const agent = localAgyAgent([{ name: 'RUBATO_LOCAL_AGY_AGENT', value: '내 에이전트' }]);
  const command = localAgySpawn('/usr/bin/agy', agent, '/project', '/home/me', {
    PATH: '/usr/bin',
    HOME: '/isolated',
    CLOUD_CODE_URL: 'https://example.invalid',
    GEMINI_API_KEY: 'must-not-forward',
  });
  assert.deepEqual(command, {
    command: '/usr/bin/agy',
    args: ['acp', '--sandbox', '--agent', '내 에이전트'],
    cwd: '/project',
    env: { HOME: '/home/me', PATH: '/usr/bin', RUBATO_AGY_WORKSPACE: '/project' },
    shell: false,
    extendEnv: false,
  });
});

test('do not accept missing profiles that agy itself silently falls back for', () => {
  const listing = 'Available agents:\nlead-alt\n내 에이전트\n';
  assert.equal(hasLocalAgyAgent(listing, 'lead'), false);
  assert.equal(hasLocalAgyAgent(listing, '내 에이전트'), true);
});

test('picker preserves the native model slug and name, and shows only Gemini 4+ models', () => {
  const neon = { slug: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)', isDefault: true };
  const flash38 = { slug: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' };
  const other = { slug: 'claude-opus-5-5', name: 'Claude' };
  assert.deepEqual(localAgyModels([neon, flash38, other], 'Antigravity'), [neon]);
  assert.deepEqual(localAgyModels([], 'Antigravity'), []);
});

test('on Windows agy keeps its profile, temp and system folders, whatever the variable case', () => {
  const command = localAgySpawn('C:\\Users\\me\\.local\\bin\\agy.exe', 'rubato-lead', 'C:\\work', 'C:\\Users\\me', {
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    RUBATO_AGY_WORKSPACE: 'C:\\untrusted',
    GEMINI_API_KEY: 'must-not-forward',
  });
  assert.deepEqual(command.env, {
    HOME: 'C:\\Users\\me',
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    RUBATO_AGY_WORKSPACE: 'C:\\work',
  });
});

test('isolated local agy flag, agent args, and user config symlinks work for extra Google accounts', { skip: process.platform === 'win32' }, async (t) => {
  assert.equal(localAgyIsolated([]), false);
  assert.equal(localAgyIsolated([{ name: 'RUBATO_LOCAL_AGY_ISOLATED', value: '1' }]), true);
  assert.equal(localAgyIsolated([{ name: 'RUBATO_LOCAL_AGY_ISOLATED', value: 'true' }]), true);

  const spawn = localAgyWithAgentArgs(
    { command: '/usr/bin/agy', args: ['acp', '--gemini-dir', '/tmp/p', '--app-data-dir', 'antigravity-acp'] },
    'rubato-lead',
  );
  assert.deepEqual(spawn.args, [
    'acp', '--gemini-dir', '/tmp/p', '--app-data-dir', 'antigravity-acp', '--sandbox', '--agent', 'rubato-lead',
  ]);

  const root = mkdtempSync(path.join(tmpdir(), 'rb-local-agy-iso-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = path.join(root, 'home');
  const profileDir = path.join(root, 'profile');
  mkdirSync(path.join(userHome, '.gemini', 'config', 'agents'), { recursive: true });
  writeFileSync(path.join(userHome, '.gemini', 'config', 'agents', 'rubato-lead.md'), '# lead\n');
  writeFileSync(path.join(userHome, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{}}\n');

  await linkLocalAgyProfileConfig(profileDir, userHome);
  const agentsLink = path.join(profileDir, 'config', 'agents');
  const mcpLink = path.join(profileDir, 'config', 'mcp_config.json');
  assert.equal(lstatSync(agentsLink).isSymbolicLink(), true);
  assert.equal(readlinkSync(agentsLink), path.join(userHome, '.gemini', 'config', 'agents'));
  assert.equal(lstatSync(mcpLink).isSymbolicLink(), true);
  assert.equal(readlinkSync(mcpLink), path.join(userHome, '.gemini', 'config', 'mcp_config.json'));
});
