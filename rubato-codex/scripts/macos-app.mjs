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
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
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
  const input = options.iconPath || join(packageRoot, '../packages/rubato-remote-web/public/icons/icon-512.png');
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
  const sourceAsar = join(source, 'Contents/Resources/app.asar');
  const before = sha(await readFile(sourceAsar));
  run('/usr/bin/ditto', [source, target]);
  const contents = join(target, 'Contents'), resources = join(contents, 'Resources');
  const infoPath = join(contents, 'Info.plist');
  const info = await plist(infoPath);
  const executable = info.CFBundleExecutable;
  if (!executable || basename(executable) !== executable) throw new Error('Unsafe upstream executable name');
  await rename(join(contents, 'MacOS', executable), join(contents, 'MacOS', executable + '.real'));
  await installIcon(resources, options);
  const archiveBytes = await readFile(join(resources, 'app.asar'));
  const archive = readArchive(archiveBytes);
  const pkg = JSON.parse(archive.get('package.json'));
  if (!pkg.main || pkg.type === 'module' || pkg.main.includes('..')) throw new Error('Unsupported Electron bootstrap format');
  const bridge = await readFile(join(packageRoot, 'macos/bootstrap.cjs'), 'utf8');
  const replacements = {};
  // Preserve native services and their original namespaces. Only the user
  // profile and Rubato workflow are separate; this is not OS-service isolation.
  let updateUiHook = 'fallback';
  // Guard the observed adapter boundary rather than rewriting renderer labels.
  // Unknown upstream layouts retain the independent menu/CLI and disabled Sparkle.
  if (!options.forceUiFallback && process.env.RUBATO_FORCE_UPDATE_UI_FALLBACK !== '1') {
    const files = Object.keys(archive.header.files['.vite']?.files?.build?.files || {});
    const candidates = files.filter(name => /^window-all-closed-.*\.js$/.test(name));
    for (const name of candidates) {
      const key = '.vite/build/' + name, code = replacements[key] || archive.get(key).toString();
      const anchor = 'constructor(e){this.options=e}async initialize(){if(!this.options.enableUpdater)';
      if (code.split(anchor).length === 2 && ['inAppUpdatesLaunchPolicyResolution=Promise.withResolvers()', 'getUpdateLifecycleState(){', 'async initializeMacSparkle(){', 'setUpdateLifecycleState('].every(s => code.includes(s))) {
        replacements[key] = code.replace(anchor, 'constructor(e){this.options=e;globalThis.__rubatoAttachUpdater?.(this)}async initialize(){if(!this.options.enableUpdater)');
        updateUiHook = 'native';
      }
    }
  }
  const rewritten = rewriteArchive(archiveBytes, {
    ...replacements,
    'package.json': JSON.stringify({ ...pkg, productName: 'Rubato', description: 'Rubato', main: 'rubato-bootstrap.cjs' }),
    'rubato-bootstrap.cjs': bridge + `\nrequire(${JSON.stringify('./' + pkg.main)});\n`,
  });
  await writeFile(join(resources, 'app.asar'), rewritten.bytes);
  info.CFBundleDisplayName = info.CFBundleName = 'Rubato';
  info.CFBundleIdentifier = trust.bundleId;
  info.CFBundleAlternateNames = ['Rubato']; info.CrProductDirName = trust.bundleId;
  info.CFBundleIconFile = 'Rubato.icns'; delete info.CFBundleIconName;
  info.CodexAppIconBaseName = 'Rubato'; info.MDItemKeywords = 'Rubato';
  // Keep upstream URL/document handlers and the native Dock plugin intact.
  info.ElectronAsarIntegrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: rewritten.headerHash } };
  await savePlist(infoPath, info);
  // Localized InfoPlist names override the primary plist in Finder.
  for (const entry of await readdir(resources)) if (entry.endsWith('.lproj')) {
    const localized = join(resources, entry, 'InfoPlist.strings');
    if (await exists(localized)) {
      try { const p = await plist(localized); p.CFBundleDisplayName = p.CFBundleName = 'Rubato'; await savePlist(localized, p); }
      catch (error) { throw new Error(`Cannot safely brand ${entry}: ${error.message}`); }
    }
  }
  await savePlist(join(resources, 'rubato-paths.plist'), { ...paths, realExecutable: executable + '.real' });
  run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'Cocoa', join(packageRoot, 'macos/launcher.m'), '-o', join(contents, 'MacOS', executable)]);
  const runtime = join(resources, 'rubato-codex'); await copyPackage(runtime);
  await cp(join(resources, 'Rubato.icns'), join(runtime, 'macos/Rubato.icns'));
  // The embedded updater never depends on the original checkout staying put.
  await mkdir(join(contents, 'Helpers'), { recursive: true });
  const updater = join(contents, 'Helpers/rubato-updater');
  await writeFile(updater, `#!/bin/sh\nset -eu\nscript=$0\nwhile [ -L "$script" ]; do\n  parent=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)\n  link=$(readlink "$script")\n  case "$link" in /*) script=$link ;; *) script=$parent/$link ;; esac\ndone\nhere=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)\nfor node in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do\n  if [ -x "$node" ] && "$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then\n    exec "$node" "$here/../Resources/rubato-codex/scripts/macos-cli.mjs" --app "$(dirname "$(dirname "$here")")" "$@"\n  fi\ndone\necho 'Rubato updater needs Node.js 24+' >&2\nexit 1\n`, { mode: 0o755 });
  const receipt = { ...paths, launchStatus: 'enabled-unverified', nativeServices: 'upstream-preserved', bundleId: trust.bundleId, upstreamVersion: original.CFBundleShortVersionString, upstreamBuild: original.CFBundleVersion, upstreamAsarSha256: before, transformVersion: trust.transformVersion, updateUiHook, updateUiPatchedFiles: Object.entries(replacements).map(([file]) => ({ file, originalSha256: sha(archive.get(file)) })), installedAt: new Date().toISOString() };
  await writeFile(markerPath(target), JSON.stringify(receipt, null, 2) + '\n');
  // The original main signature binds the old Info.plist. Refresh that signature
  // without replacing its original entitlements or executable instructions.
  // Frameworks, services and native modules retain their original signatures.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags,runtime', join(contents, 'MacOS', executable + '.real')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', updater]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  if (sha(await readFile(sourceAsar)) !== before) throw new Error('Upstream changed while building');
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
    const setup = await installPackage({ ...options, codexHome: paths.codexHome, opencodexHome: join(paths.codexHome, 'opencodex'), codexPath: join(next, 'Contents/Resources/codex'), providers: options.providers, pluginRoot: packageRoot, disableSkillPaths: [...(options.disableSkillPaths || []), ...sharedDuplicates] });
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
