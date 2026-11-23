import test from 'node:test';
import assert from 'node:assert/strict';
import { appEnvironment, guiLaunchCommand } from '../detach-gui.mjs';

test('macOS relaunch belongs to LaunchServices and preserves the ready handshake', () => {
  assert.deepEqual(guiLaunchCommand('/start.sh', '/Applications/Rubato.app', {
    platform: 'darwin', env: { RUBATO_GUI_UPDATE_TOKEN: 'token', T3CODE_HOME: '/custom home' },
  }), ['/usr/bin/open', ['-a', '/Applications/Rubato.app', '--env', 'RUBATO_GUI_UPDATE_TOKEN=token', '--env', 'T3CODE_HOME=/custom home']]);
});

test('non-macOS and explicit script-only launches keep the detached launcher', () => {
  assert.deepEqual(guiLaunchCommand('/start.sh', '/app', { platform: 'linux' }), ['/start.sh', []]);
  assert.deepEqual(guiLaunchCommand('/start.sh', undefined, { platform: 'darwin' }), ['/start.sh', []]);
});

test('the reopened app gets neither an agent session nor the job\'s own markers', () => {
  assert.deepEqual(appEnvironment({ HOME: '/h', PI_SESSION_ID: 's', PI_SESSION_FILE: '/f', RUBATO_GUI_RESTART_APP: '1',
    RUBATO_GUI_UPDATE_RELAUNCH: '1', RUBATO_GUI_UPDATE_NODE: '/node', RUBATO_GUI_UPDATE_TOKEN: 't' }),
  { HOME: '/h', RUBATO_GUI_UPDATE_TOKEN: 't' });
});
