import test from 'node:test';
import assert from 'node:assert/strict';
import { guiLaunchCommand } from '../detach-gui.mjs';

test('macOS relaunch belongs to LaunchServices and preserves the ready handshake', () => {
  assert.deepEqual(guiLaunchCommand('/start.sh', '/Applications/Rubato.app', {
    platform: 'darwin', env: { RUBATO_GUI_UPDATE_TOKEN: 'token', T3CODE_HOME: '/custom home' },
  }), ['/usr/bin/open', ['-a', '/Applications/Rubato.app', '--env', 'RUBATO_GUI_UPDATE_TOKEN=token', '--env', 'T3CODE_HOME=/custom home']]);
});

test('non-macOS and explicit script-only launches keep the detached launcher', () => {
  assert.deepEqual(guiLaunchCommand('/start.sh', '/app', { platform: 'linux' }), ['/start.sh', []]);
  assert.deepEqual(guiLaunchCommand('/start.sh', undefined, { platform: 'darwin' }), ['/start.sh', []]);
});
