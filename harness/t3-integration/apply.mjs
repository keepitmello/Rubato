#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const overlays = ['apps/server/src/provider/Drivers/RubatoPiDriver.ts', 'apps/server/src/provider/RubatoPiInventory.ts'];
// 값이 [anchor, addition] 이면 anchor 앞에 붙이고, [from, to, 'replace'] 면 갈아끼운다.
// 앱 이름·번들 id·아이콘은 T3 가 const 로 박아둬서 앞에 덧붙이는 것으로는 못 바꾼다.
const edits = {
  'apps/server/src/provider/builtInDrivers.ts': [
    ['import type { AnyProviderDriver } from "./ProviderDriver.ts";', 'import { RubatoPiDriver } from "./Drivers/RubatoPiDriver.ts";\n'],
    ['  AntigravityDriver,\n];', '  RubatoPiDriver,\n'],
  ],
  'apps/server/src/serverRuntimeStartup.ts': [
    ['import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";', 'import { makeRubatoPiInventory } from "./provider/RubatoPiInventory.ts";\n'],
    ['      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);', '      const rubatoInventory = yield* makeRubatoPiInventory.pipe(Scope.provide(reactorScope));\n'],
    ['      yield* Effect.logDebug("startup phase: complete");', '      yield* rubatoInventory.start.pipe(Scope.provide(reactorScope));\n'],
  ],
  // Dock 이름·아이콘·번들 id. 값 자체는 환경변수로 빼고 T3 기본값은 폴백으로 남긴다 —
  // 경로를 여기 박으면 머신마다 다른 레포 위치를 못 따라간다. start-gui.sh 가 채운다.
  'apps/desktop/scripts/electron-launcher.mjs': [
    [
      'const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";',
      'const APP_DISPLAY_NAME =\n  process.env.RUBATO_GUI_APP_NAME || (isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)");',
      'replace',
    ],
    [
      ['const APP_BUNDLE_ID = isDevelopment', '  ? `com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`', '  : "com.t3tools.t3code";'].join('\n'),
      ['const APP_BUNDLE_ID =', '  process.env.RUBATO_GUI_BUNDLE_ID ||', '  (isDevelopment', '    ? `com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`', '    : "com.t3tools.t3code");'].join('\n'),
      'replace',
    ],
    [
      'const productionMacIconPngPath = NodePath.join(repoRoot, "assets", "prod", "black-macos-1024.png");',
      'const productionMacIconPngPath =\n  process.env.RUBATO_GUI_ICON_PNG ||\n  NodePath.join(repoRoot, "assets", "prod", "black-macos-1024.png");',
      'replace',
    ],
    [
      ['    NSScreenCaptureUsageDescription:', '      "T3 Code captures the active window when you use the snapshot shortcut.",', '    NSDocumentsFolderUsageDescription: "T3 Code reads project files you open in the desktop app.",'].join('\n'),
      ['    NSScreenCaptureUsageDescription: `${APP_DISPLAY_NAME} captures the active window when you use the snapshot shortcut.`,', '    NSDocumentsFolderUsageDescription: `${APP_DISPLAY_NAME} reads project files you open in the desktop app.`,'].join('\n'),
      'replace',
    ],
  ],
  // 번들 plist 만으로는 안 된다. 소스에서 켠 앱(isPackaged=false)은 실행 중에
  // 자기 png 로 Dock 타일을 다시 그린다.
  'apps/desktop/src/app/DesktopAssets.ts': [
    [
      '  return environment.path.join(environment.rootDir, "assets", brand, fileName);',
      '  if (ext === "png" && process.env.RUBATO_GUI_ICON_PNG) return process.env.RUBATO_GUI_ICON_PNG;\n  return environment.path.join(environment.rootDir, "assets", brand, fileName);',
      'replace',
    ],
  ],
  // 메뉴 막대와 정보 창에 쓰는 이름. 번들 이름과 따로 논다.
  'apps/desktop/src/app/DesktopEnvironment.ts': [
    [
      'const APP_BASE_NAME = "T3 Code";',
      'const APP_BASE_NAME = process.env.RUBATO_GUI_APP_NAME || "T3 Code";',
      'replace',
    ],
    [
      '    displayName: `${APP_BASE_NAME} (${stageLabel})`,',
      '    displayName: process.env.RUBATO_GUI_APP_NAME || `${APP_BASE_NAME} (${stageLabel})`,',
      'replace',
    ],
  ],
};
function transform(text, changes) {
  for (const [anchor, addition, mode] of changes) {
    if (text.split(anchor).length !== 2) throw new Error(`T3 integration anchor is missing or ambiguous: ${anchor}`);
    text = mode === 'replace' ? text.replace(anchor, addition) : text.replace(anchor, addition + anchor);
  }
  return text;
}
function untransform(text, changes) {
  for (const [anchor, addition, mode] of changes)
    text = mode === 'replace' ? text.replace(addition, anchor) : text.replace(addition + anchor, anchor);
  return text;
}
async function existing(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlink target: ${file}`);
    return await readFile(file,'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,content,{flag:'wx',mode:0o644}); await rename(temporary,file); }
  finally { await unlink(temporary).catch((error) => { if (error.code!=='ENOENT') throw error; }); }
}
export async function applyIntegration({t3,check=false,remove=false}) {
  const target = await realpath(t3);
  const upstream = JSON.parse(await readFile(path.join(root,'upstream.json'),'utf8'));
  const manifestPath = path.join(target,'.rubato-pi-overlay.json');
  const oldText = await existing(manifestPath);
  const old = oldText ? JSON.parse(oldText) : {version:1,files:{}};
  if (old.version!==1) throw new Error('Unsupported previous overlay manifest');
  const planned = [];
  const manifest = {version:1,upstreamCommit:upstream.upstreamCommit,files:{}};
  for (const relative of [...Object.keys(upstream.targets),...overlays]) {
    const destination = path.join(target,relative);
    const parent = await realpath(path.dirname(destination));
    if (!parent.startsWith(target + path.sep)) throw new Error(`Target escapes T3 root: ${relative}`);
    const current = await existing(destination);
    let original;
    let next;
    if (relative in edits) {
      if (current===null) throw new Error(`T3 source file is missing: ${relative}`);
      original = untransform(current,edits[relative]);
      if (hash(original)!==upstream.targets[relative]) throw new Error(`T3 source changed outside this overlay: ${relative}`);
      next = transform(original,edits[relative]);
      if (current!==original && current!==next) throw new Error(`Partial external edit in T3 target: ${relative}`);
    } else {
      original = old.files[relative]?.original ?? null;
      next = await readFile(path.join(root,'overlay',relative),'utf8');
      if (current!==null && current!==next && hash(current)!==old.files[relative]?.installedHash)
        throw new Error(`Refusing to overwrite a different provider file: ${relative}`);
    }
    if (remove) {
      if (!old.files[relative]) throw new Error(`No installation record for ${relative}`);
      if (current===null || hash(current)!==old.files[relative].installedHash) throw new Error(`Installed file has local changes: ${relative}`);
      next = old.files[relative].original;
    }
    manifest.files[relative] = {original,installedHash:next===null?null:hash(next)};
    planned.push({relative,destination,current,next});
  }
  if (!check) {
    for (const item of planned) if (item.current!==item.next) {
      if (item.next===null) await unlink(item.destination);
      else await atomic(item.destination,item.next);
    }
    if (remove) await unlink(manifestPath);
    else await atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }
  return {compatible:true,check,remove,changes:planned.filter((item)=>item.current!==item.next).map((item)=>item.relative),
    upstreamCommit:upstream.upstreamCommit};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options:{t3:{type:'string'},check:{type:'boolean'},remove:{type:'boolean'}}});
    if (!values.t3) throw new Error('Usage: node harness/t3-integration/apply.mjs --t3 /absolute/t3code [--check | --remove]');
    console.log(JSON.stringify(await applyIntegration(values),null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
