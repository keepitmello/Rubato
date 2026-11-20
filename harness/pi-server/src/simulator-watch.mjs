// Shuts down an iOS simulator nobody is looking at once it is forgotten or runs away. An agent
// boots one headless to test an app and leaves; when its runtime later breaks (an Xcode update),
// the device's launchd crash-loops its services for days. On 2026-11-20 one booted six days
// earlier was taking 40-80% CPU with 188 dead children, and `simctl` itself no longer answered.
//
// A device is left alone while Simulator.app is open: then a person is using it.
import { execFile } from 'node:child_process';

/** A device booted this long with Simulator.app closed is forgotten. */
export const FORGOTTEN_MS = 6 * 60 * 60 * 1000;
/** A device whose launchd used more than this share of one core between two looks runs away. */
export const RUNAWAY_SHARE = 0.25;
export const LOOK_EVERY_MS = 10 * 60 * 1000;

const run = (file, args, timeout) => new Promise((resolve) => execFile(file, args, { timeout },
  (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })));

/** `[[dd-]hh:]mm:ss[.cc]` (ps etime / time) in milliseconds. */
export function psDuration(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return (((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** The booted devices: one `launchd_sim` per device, its UDID in the bootstrap path. */
export function parseSimulators(psOutput) {
  const devices = [];
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+launchd_sim\s+\S*\/Devices\/([0-9A-F-]{36})\//i);
    if (match) devices.push({ pid: Number(match[1]), upMs: psDuration(match[2]), cpuMs: psDuration(match[3]), udid: match[4] });
  }
  return devices;
}

/**
 * The devices to shut down now, given this look and the one before (`previous`: udid → { cpuMs,
 * at }). Returns `[{ udid, pid, reason }]`.
 */
export function devicesToStop(devices, previous, { now, simulatorAppOpen, forgottenMs = FORGOTTEN_MS, runawayShare = RUNAWAY_SHARE }) {
  if (simulatorAppOpen) return [];
  const stop = [];
  for (const device of devices) {
    const before = previous.get(device.udid);
    const share = before && now > before.at ? (device.cpuMs - before.cpuMs) / (now - before.at) : 0;
    if (share > runawayShare) stop.push({ udid: device.udid, pid: device.pid, reason: `used ${Math.round(share * 100)}% CPU` });
    else if (device.upMs > forgottenMs) stop.push({ udid: device.udid, pid: device.pid, reason: `booted ${Math.round(device.upMs / 3_600_000)} h ago` });
  }
  return stop;
}

export function createSimulatorWatch({ log = () => {}, exec = run, kill = (pid) => process.kill(pid, 'SIGKILL'), clock = Date.now } = {}) {
  const previous = new Map();
  return {
    async look() {
      const ps = await exec('/bin/ps', ['-Ao', 'pid=,etime=,time=,args='], 10_000);
      if (!ps.ok) return [];
      const devices = parseSimulators(ps.stdout);
      const now = clock();
      const simulatorAppOpen = (await exec('/usr/bin/pgrep', ['-x', 'Simulator'], 5_000)).ok;
      const stop = devicesToStop(devices, previous, { now, simulatorAppOpen });
      previous.clear();
      for (const device of devices) previous.set(device.udid, { cpuMs: device.cpuMs, at: now });
      for (const device of stop) {
        // A broken runtime can leave simctl hanging; its launchd then goes directly.
        const shut = await exec('/usr/bin/xcrun', ['simctl', 'shutdown', device.udid], 60_000);
        if (!shut.ok) try { kill(device.pid); } catch { /* ended */ }
        previous.delete(device.udid);
        log('simulator shut down', { udid: device.udid, reason: device.reason, how: shut.ok ? 'simctl' : 'killed' });
      }
      return stop;
    },
  };
}

/** The resident service (resident-services.mjs): looks every ten minutes on macOS. */
export async function start(ctx) {
  if (process.platform !== 'darwin') return {};
  const watch = createSimulatorWatch({ log: (event, details) => ctx.log(event, details) });
  const look = () => watch.look().catch((error) => ctx.onError(error));
  const timer = setInterval(look, ctx.options?.everyMs ?? LOOK_EVERY_MS);
  void look();
  return { close: () => clearInterval(timer) };
}
