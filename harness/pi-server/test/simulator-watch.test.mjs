import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatorWatch, devicesToStop, parseSimulators, psDuration } from '../src/simulator-watch.mjs';

const UDID = 'DF30714E-39BC-4A95-86C8-3210E37CCCB6';
const OTHER = '0A1B2C3D-0000-4000-8000-000000000001';
const line = (pid, etime, time, udid) =>
  `${pid} ${etime} ${time} launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`;

test('ps durations read with days, hours and fractions', () => {
  assert.equal(psDuration('06-22:26:53'), ((6 * 24 + 22) * 3600 + 26 * 60 + 53) * 1000);
  assert.equal(psDuration('12:05'), (12 * 60 + 5) * 1000);
  assert.equal(psDuration('1:02:03.50'), 3723500);
});

test('each booted device is read from its launchd_sim line; other processes are not', () => {
  const ps = [line(23926, '06-22:26:53', '61:10.00', UDID), '  355 18495-18:43:35 12:00.00 /usr/libexec/fseventsd',
    line(400, '10:00', '0:01.00', OTHER)].join('\n');
  assert.deepEqual(parseSimulators(ps).map(({ pid, udid }) => ({ pid, udid })), [{ pid: 23926, udid: UDID }, { pid: 400, udid: OTHER }]);
});

test('a device left booted for hours or burning CPU is stopped; a fresh quiet one and anything with Simulator.app open is not', () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const devices = [
    { udid: UDID, pid: 1, upMs: 7 * hour, cpuMs: 0 },
    { udid: OTHER, pid: 2, upMs: hour, cpuMs: 400_000 },
    { udid: 'quiet', pid: 3, upMs: hour, cpuMs: 1_000 },
  ];
  const previous = new Map([[OTHER, { cpuMs: 100_000, at: now - 600_000 }], ['quiet', { cpuMs: 900, at: now - 600_000 }]]);
  assert.deepEqual(devicesToStop(devices, previous, { now, simulatorAppOpen: false }).map(({ udid, reason }) => [udid, reason]),
    [[UDID, 'booted 7 h ago'], [OTHER, 'used 50% CPU']]);
  assert.deepEqual(devicesToStop(devices, previous, { now, simulatorAppOpen: true }), []);
});

test('a device simctl cannot shut down has its launchd killed', async () => {
  const calls = [];
  const killed = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === '/bin/ps') return { ok: true, stdout: line(23926, '06-22:26:53', '61:10.00', UDID) };
    if (file === '/usr/bin/pgrep') return { ok: false, stdout: '' };
    return { ok: false, stdout: '' }; // simctl timed out
  };
  const events = [];
  const watch = createSimulatorWatch({ exec, kill: (pid) => killed.push(pid), log: (event, details) => events.push(details) });
  const stopped = await watch.look();
  assert.deepEqual(stopped.map((device) => device.udid), [UDID]);
  assert.ok(calls.includes(`/usr/bin/xcrun simctl shutdown ${UDID}`));
  assert.deepEqual(killed, [23926]);
  assert.equal(events[0].how, 'killed');
});
