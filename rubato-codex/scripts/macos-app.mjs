import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, arch, homedir } from 'node:os';
import { appPaths } from './install-target.mjs';
import { readArchive, rewriteArchive } from './asar.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const trust = JSON.parse(await readFile(join(packageRoot, 'macos/upstream-trust.json'), 'utf8'));
export const RUBATO_DEFAULT_MODEL = 'gpt-5.6-sol';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export function withRubatoDefaultModel(content, model = RUBATO_DEFAULT_MODEL) {
  const firstTable = content.search(/^\s*\[/m);
  const root = content.slice(0, firstTable === -1 ? content.length : firstTable);
  if (/^\s*model\s*=/m.test(root)) return content;
  return `model = ${JSON.stringify(model)}\n${content}`;
}
export function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(`${basename(command)} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r.stdout;
}
export async function plist(path) { return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])); }
async function savePlist(path, data) {
  await writeFile(path, JSON.stringify(data));
  run('/usr/bin/plutil', ['-convert', 'xml1', path]);
}
export function assertAppTarget(path) {
  if (!path.endsWith('/Rubato.app') || path === '/Rubato.app') throw new Error('App target must be an explicit directory ending in /Rubato.app');
}
export async function verifyUpstream(path, release) {
  const info = await plist(join(path, 'Contents/Info.plist'));
  if (info.CFBundleIdentifier !== trust.upstreamBundleId) throw new Error('Unexpected upstream bundle identifier');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and certificate leaf[subject.OU] = "${trust.teamId}" and identifier "${trust.upstreamBundleId}"`, path]);
  if (release && (info.CFBundleVersion !== release.build || info.CFBundleShortVersionString !== release.version)) throw new Error('Signed app does not match appcast version/build');
  return info;
}
const markerPath = app => join(app, 'Contents/Resources/rubato-build.json');
export async function managedApp(app) {
  assertAppTarget(app);
  const marker = JSON.parse(await readFile(markerPath(app), 'utf8'));
  const info = await plist(join(app, 'Contents/Info.plist'));
  if (marker.bundleId !== trust.bundleId || info.CFBundleIdentifier !== trust.bundleId || marker.appPath !== app.replace(/\.previous$/, '')) throw new Error('App does not belong to this installer');
  return marker;
}
async function assertDestination(app) {
  assertAppTarget(app);
  if (await exists(app)) {
    if ((await lstat(app)).isSymbolicLink()) throw new Error('Refusing a symlink application target');
    await managedApp(app);
  }
}
export function validateDownloadUrl(value) {
  const url = new URL(value);
  if (url.origin !== trust.downloadOrigin || !url.pathname.startsWith(trust.downloadPathPrefix) || url.username || url.password || !url.pathname.endsWith('.zip')) throw new Error('Untrusted upstream download URL');
  return url.href;
}
export function parseAppcast(xml, cpu = arch()) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Appcast entities are not supported');
  const releases = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1].replace(/<sparkle:deltas>[\s\S]*?<\/sparkle:deltas>/g, '');
    const value = tag => item.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
    const hardware = value('sparkle:hardwareRequirements');
    if (hardware && !hardware.split(',').includes(cpu)) continue;
    const enclosure = item.match(/<enclosure\s+([^>]+)\/?\s*>/)?.[1];
    if (!enclosure) continue;
    const attrs = Object.fromEntries([...enclosure.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2].replaceAll('&amp;', '&')]));
    const release = { version: value('sparkle:shortVersionString'), build: value('sparkle:version'), minimumSystemVersion: value('sparkle:minimumSystemVersion'), url: validateDownloadUrl(attrs.url), signature: attrs['sparkle:edSignature'], length: Number(attrs.length) };
    if (!/^\d+$/.test(release.build || '') || !release.version || !release.signature || !Number.isSafeInteger(release.length) || release.length <= 0) throw new Error('Incomplete appcast release');
    releases.push(release);
  }
  return releases.sort((a, b) => Number(b.build) - Number(a.build));
}
export async function availableReleases() {
  const response = await fetch(trust.appcastUrl, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Appcast HTTP ${response.status}`);
  const releases = parseAppcast(await response.text());
  if (!releases.length) throw new Error(`No official release for ${arch()}`);
  return releases;
}
export function verifyDownload(bytes, release) {
  if (bytes.length !== release.length) throw new Error('Upstream archive length mismatch');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(trust.sparklePublicKey, 'base64')]), format: 'der', type: 'spki' });
  if (!verify(null, bytes, key, Buffer.from(release.signature, 'base64'))) throw new Error('Upstream Sparkle archive signature mismatch');
}
async function downloadApp(release, dir) {
  validateDownloadUrl(release.url);
  const zip = join(dir, 'upstream.zip');
  run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--proto', '=https', '--max-time', '600', '--output', zip, release.url], { timeout: 610_000 });
  verifyDownload(await readFile(zip), release);
  const entries = run('/usr/bin/unzip', ['-Z1', zip]);
  if (entries.split('\n').some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Unsafe ZIP entry');
  const unpacked = join(dir, 'unpacked'); await mkdir(unpacked);
  run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
  const apps = (await readdir(unpacked)).filter(n => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error('Expected exactly one upstream app');
  const app = join(unpacked, apps[0]);
  await verifyUpstream(app, release);
  return app;
}
async function copyPackage(target) {
  await cp(packageRoot, target, { recursive: true, filter: source => !source.split('/').some(p => ['node_modules', '.git', '__pycache__'].includes(p)) });
}
export async function installIcon(resources, options = {}) {
  const input = options.iconPath || join(packageRoot, 'macos/Rubato.png');
  const embedded = join(packageRoot, 'macos/Rubato.icns');
  if (!options.iconPath && await exists(embedded)) {
    await cp(embedded, join(resources, 'Rubato.icns')); return;
  }
  if (input.endsWith('.icns')) { await cp(input, join(resources, 'Rubato.icns')); return; }
  const iconset = await mkdtemp(join(tmpdir(), 'rubato-icon-'));
  const set = join(iconset, 'Rubato.iconset'); await mkdir(set);
  try {
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      const pixels = size * scale;
      run('/usr/bin/sips', ['-z', String(pixels), String(pixels), input, '--out', join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(resources, 'Rubato.icns')]);
  } finally { await rm(iconset, { recursive: true, force: true }); }
}
export async function transformApp(source, target, paths, options = {}) {
  const original = await verifyUpstream(source, options.release);
  const contents = join(target, 'Contents'), resources = join(contents, 'Resources');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(resources, { recursive: true });
  await installIcon(resources, options);
  const upstreamApp = await realpath(source);
  await savePlist(join(contents, 'Info.plist'), {
    CFBundleIdentifier: trust.bundleId, CFBundleName: 'Rubato',
    CFBundleDisplayName: 'Rubato', CFBundleExecutable: 'Rubato',
    CFBundlePackageType: 'APPL', CFBundleIconFile: 'Rubato.icns',
    CFBundleShortVersionString: '0.1.0', CFBundleVersion: '2', LSUIElement: true,
  });
  await savePlist(join(resources, 'rubato-paths.plist'), { ...paths, upstreamApp });
  run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'Cocoa', join(packageRoot, 'macos/launcher.m'), '-o', join(contents, 'MacOS/Rubato')]);
  const runtime = join(resources, 'rubato-codex'); await copyPackage(runtime);
  await cp(join(resources, 'Rubato.icns'), join(runtime, 'macos/Rubato.icns'));
  await mkdir(join(contents, 'Helpers'), { recursive: true });
  const updater = join(contents, 'Helpers/rubato-updater');
  await writeFile(updater, '#!/bin/sh\necho "Rubato uses the unchanged official app. Update ChatGPT/Codex through its official updater; rerun the Rubato installer to update workflows."\n', { mode: 0o755 });
  const receipt = { ...paths, upstreamApp, mode: 'signed-profile-launcher',
    launchStatus: 'enabled-unverified', bundleId: trust.bundleId,
    upstreamVersion: original.CFBundleShortVersionString, upstreamBuild: original.CFBundleVersion,
    transformVersion: 2, updateUiHook: 'official-app', installedAt: new Date().toISOString() };
  await writeFile(markerPath(target), JSON.stringify(receipt, null, 2) + '\n');
  run('/usr/bin/codesign', ['--force', '--sign', '-', updater]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  await verifyUpstream(upstreamApp);
  return receipt;
}
export async function appPlan(options = {}) {
  const paths = appPaths(options);
  assertAppTarget(paths.appPath);
  if (process.platform !== 'darwin') throw new Error('Rubato.app requires macOS; use --target codex explicitly on other platforms');
  await assertDestination(paths.appPath);
  const source = options.upstreamApp || '/Applications/ChatGPT.app';
  if (resolve(source) === paths.appPath || await realpath(source) === paths.appPath) throw new Error('Source and target must differ');
  const info = await verifyUpstream(source);
  return { action: 'install-app', ...paths, source, upstreamVersion: info.CFBundleShortVersionString, existingCodex: 'profile not modified; native services preserved', providers: options.providers || 'none', launch: 'close original app first; GUI verification pending' };
}
async function installUpdaterLink(paths) {
  const target = join(paths.appPath, 'Contents/Helpers/rubato-updater');
  if (await exists(paths.updaterLink)) {
    if (!(await lstat(paths.updaterLink)).isSymbolicLink() || resolve(dirname(paths.updaterLink), await readlink(paths.updaterLink)) !== target) throw new Error('Existing rubato-update belongs to another installation');
    return;
  }
  await mkdir(dirname(paths.updaterLink), { recursive: true }); await symlink(target, paths.updaterLink);
}
export async function withAppLock(app, operation) {
  assertAppTarget(app);
  const lock = app + '.update-lock';
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another app operation or a stale lock exists: ${lock}. Check its owner before removing it.`);
    throw error;
  }
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), app }));
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function installApp(options = {}) {
  if (options.dryRun) return appPlan(options);
  const paths = appPaths(options);
  return withAppLock(paths.appPath, () => applyAppInstall(options));
}
async function applyAppInstall(options = {}) {
  const plan = await appPlan(options);
  if (options.dryRun) return plan;
  const paths = appPaths(options);
  await preflightLink(paths);
  const space = await statfs(dirname(paths.appPath));
  if (space.bavail * space.bsize < 4 * 1024 ** 3) throw new Error('Need at least 4 GiB free to stage Rubato safely');
  const stage = await mkdtemp(join(dirname(paths.appPath), '.rubato-stage-'));
  try {
    const next = join(stage, 'Rubato.app');
    await transformApp(plan.source, next, paths, options);
    // Existing user Codex settings/auth/sessions are never copied.
    const { installPackage } = await import('./install.mjs');
    const bundledNames = new Set((await readdir(join(packageRoot, 'skills'))).map(n => n.toLowerCase()));
    const sharedRoot = join(homedir(), '.agents/skills');
    const sharedNames = await exists(sharedRoot) ? await readdir(sharedRoot) : [];
    const sharedDuplicates = [];
    for (const name of sharedNames) if (bundledNames.has(name.toLowerCase()) && await exists(join(sharedRoot, name, 'SKILL.md'))) sharedDuplicates.push(join(sharedRoot, name, 'SKILL.md'));
    const policyPath = join(paths.codexHome, 'rubato-codex/providers.json');
    const previousPolicy = await exists(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : null;
    const opencodexHome = previousPolicy?.opencodex?.configPath ? dirname(previousPolicy.opencodex.configPath) : join(paths.codexHome, 'opencodex');
    const configPath = join(paths.codexHome, 'config.toml');
    await mkdir(paths.codexHome, { recursive: true });
    const currentConfig = await exists(configPath) ? await readFile(configPath, 'utf8') : '';
    const configWithDefault = withRubatoDefaultModel(currentConfig);
    if (configWithDefault !== currentConfig) await writeFile(configPath, configWithDefault, { mode: 0o600 });
    const setup = await installPackage({ ...options, codexHome: paths.codexHome, opencodexHome, codexPath: join(plan.source, 'Contents/Resources/codex'), providers: options.providers, pluginRoot: packageRoot, disableSkillPaths: [...(options.disableSkillPaths || []), ...sharedDuplicates] });
    await replaceApp(next, paths.appPath);
    await installUpdaterLink(paths);
    return { ...plan, installed: true, verification: 'structural; GUI/login/native feature checks pending', setup, nextStep: 'Close the original ChatGPT/Codex app, then open Rubato for runtime verification.' };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
async function preflightLink(paths) {
  if (await exists(paths.updaterLink) && (!(await lstat(paths.updaterLink)).isSymbolicLink() || resolve(dirname(paths.updaterLink), await readlink(paths.updaterLink)) !== join(paths.appPath, 'Contents/Helpers/rubato-updater'))) throw new Error('Existing rubato-update is not installer-owned');
}
export function runningApps() {
  const output = run('/bin/ps', ['-axo', 'pid=,command=']);
  return output.split('\n').filter(line => /\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\.real)?(?:\s|$)/.test(line));
}
async function replaceApp(next, target) {
  await assertDestination(target);
  if (runningApps().some(line => line.includes(target + '/'))) throw new Error('Close Rubato before replacing it; the running app was not stopped');
  const previous = target + '.previous';
  if (await exists(previous)) {
    const marker = JSON.parse(await readFile(markerPath(previous), 'utf8'));
    if (marker.bundleId !== trust.bundleId || marker.appPath !== target || (await lstat(previous)).isSymbolicLink()) throw new Error('Unowned previous-app backup');
    await rm(previous, { recursive: true });
  }
  const hadApp = await exists(target);
  if (hadApp) await rename(target, previous);
  try { await rename(next, target); }
  catch (error) { if (hadApp) await rename(previous, target); throw error; }
}
export async function updateApp(options = {}) {
  if (['check', 'version'].includes(options.action)) return applyAppUpdate(options);
  const paths = appPaths(options);
  return withAppLock(paths.appPath, () => applyAppUpdate(options));
}
async function applyAppUpdate(options = {}) {
  const paths = appPaths(options); const installed = await managedApp(paths.appPath);
  if (options.action === 'version') return installed;
  if (installed.mode === 'signed-profile-launcher') {
    const current = await verifyUpstream(installed.upstreamApp);
    if (options.action === 'rollback') throw new Error('Launcher mode uses the official app; rollback must not restore the broken re-signed clone.');
    return { status: 'official-updater', version: current.CFBundleShortVersionString, nextStep: 'Update the official ChatGPT/Codex app normally. Rerun the Rubato installer to update workflows.' };
  }
  if (options.action === 'rollback') {
    if (runningApps().some(line => line.includes(paths.appPath + '/'))) throw new Error('Close Rubato before rollback');
    const previous = paths.appPath + '.previous';
    const p = JSON.parse(await readFile(markerPath(previous), 'utf8'));
    if (p.bundleId !== trust.bundleId || p.appPath !== paths.appPath || (await lstat(previous)).isSymbolicLink()) throw new Error('No owned rollback app');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', previous]);
    const swap = await mkdtemp(join(dirname(paths.appPath), '.rubato-rollback-'));
    try {
      await rename(paths.appPath, join(swap, 'Rubato.app'));
      try { await rename(previous, paths.appPath); } catch (e) { await rename(join(swap, 'Rubato.app'), paths.appPath); throw e; }
      await rename(join(swap, 'Rubato.app'), previous);
    } finally { await rm(swap, { recursive: true, force: true }); }
    return { status: 'rolled-back', version: p.upstreamVersion, userState: 'preserved' };
  }
  const releases = await availableReleases();
  const release = options.upstreamVersion ? releases.find(r => r.version === options.upstreamVersion) : releases[0];
  if (!release) throw new Error('Requested version is not in the verified appcast');
  const available = Number(release.build) > Number(installed.upstreamBuild);
  if (options.action === 'check' || (!available && !options.upstreamVersion)) return { status: available ? 'available' : 'up-to-date', current: installed.upstreamVersion, latest: release.version, build: release.build, updateUiHook: installed.updateUiHook };
  if (runningApps().some(line => line.includes(paths.appPath + '/'))) throw new Error('Save your work and close Rubato before installing; run rubato-update again.');
  const space = await statfs(dirname(paths.appPath));
  if (space.bavail * space.bsize < Math.max(4 * 1024 ** 3, release.length * 7)) throw new Error('Insufficient free space for verified download, extraction and staged app copy');
  const stage = await mkdtemp(join(dirname(paths.appPath), '.rubato-update-'));
  try {
    const source = await downloadApp(release, stage);
    const next = join(stage, 'Rubato.app');
    await transformApp(source, next, installed, { release, iconPath: join(paths.appPath, 'Contents/Resources/Rubato.icns') });
    await replaceApp(next, paths.appPath);
    return { status: 'installed', version: release.version, previous: installed.upstreamVersion, userState: 'preserved', nextStep: 'Open Rubato.app' };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function doctor(options = {}) {
  const paths = appPaths(options), checks = [];
  for (const [name, check] of [
    ['managed app', () => managedApp(paths.appPath)],
    ['code signature', () => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.appPath])],
    ['updater', () => access(join(paths.appPath, 'Contents/Helpers/rubato-updater'))],
    ['official appcast', () => availableReleases()],
  ]) { try { await check(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: e.message }); } }
  const space = await statfs(dirname(paths.appPath));
  return { ...paths, sqliteHome: join(paths.codexHome, 'sqlite'), bundleId: trust.bundleId, checks, freeBytes: space.bavail * space.bsize, updateLock: await exists(paths.appPath + '.update-lock'), processes: runningApps(), concurrentApps: 'unsupported' };
}
