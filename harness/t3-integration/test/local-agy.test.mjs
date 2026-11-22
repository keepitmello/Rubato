import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLocalAgyAgent, localAgyAgent, localAgyModels, localAgySpawn } from
  '../overlay/apps/server/src/provider/RubatoLocalAgy.ts';

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
    env: { HOME: '/home/me', PATH: '/usr/bin' },
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
  });
});
