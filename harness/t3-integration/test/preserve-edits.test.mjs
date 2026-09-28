import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {preserveLocalEdits} from '../apply.mjs';

const hash=(value)=>createHash('sha256').update(value).digest('hex');
const exists=(file)=>access(file).then(()=>true,()=>false);

// A hand edit in t3-source used to stop every later install ("Installed file has
// local changes") or vanish under checkout --force. Now it is moved aside first.
test('hand edits in t3-source are backed up; overlay output, upstream and installer icons are not', async(t)=>{
  const root=await mkdtemp(path.join(tmpdir(),'rb-preserve-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const t3=path.join(root,'t3');
  const backupDir=path.join(root,'backup');
  await mkdir(path.join(t3,'src'),{recursive:true});
  const git=(...args)=>execFileSync('git',['-C',t3,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
  git('init','-q');
  for (const name of ['target.ts','clean-target.ts','upstream.ts','icon.png']) await writeFile(path.join(t3,'src',name),`upstream ${name}\n`);
  git('add','.');
  git('-c','user.email=t@t','-c','user.name=t','commit','-qm','pin');
  const overlaid='upstream target.ts\n// rubato edit\n';
  const overlayFile='export const rubato = 1;\n';
  await writeFile(path.join(t3,'src','clean-target.ts'),'upstream clean-target.ts\n// rubato edit\n');
  await writeFile(path.join(t3,'src','Overlay.ts'),'export const rubato = 1;\n// hand edit\n');
  await writeFile(path.join(t3,'src','CleanOverlay.ts'),overlayFile);
  await writeFile(path.join(t3,'src','target.ts'),overlaid+'// hand edit\n');
  await writeFile(path.join(t3,'src','upstream.ts'),'upstream upstream.ts\n// hand edit\n');
  await writeFile(path.join(t3,'src','icon.png'),await readFile(new URL('../assets/Rubato.png',import.meta.url)));
  await writeFile(path.join(t3,'.rubato-pi-overlay.json'),JSON.stringify({version:1,files:{
    'src/target.ts':{original:'upstream target.ts\n',installedHash:hash(overlaid)},
    'src/clean-target.ts':{original:'upstream clean-target.ts\n',installedHash:hash('upstream clean-target.ts\n// rubato edit\n')},
    'src/Overlay.ts':{original:null,installedHash:hash(overlayFile)},
    'src/CleanOverlay.ts':{original:null,installedHash:hash(overlayFile)},
  }}));

  const result=await preserveLocalEdits({t3,backupDir});
  assert.deepEqual([...result.preserved].sort(),['src/Overlay.ts','src/target.ts','src/upstream.ts']);
  assert.equal(result.backupDir,backupDir);
  assert.equal(await readFile(path.join(backupDir,'src/Overlay.ts'),'utf8'),'export const rubato = 1;\n// hand edit\n');
  assert.equal(await readFile(path.join(backupDir,'src/target.ts'),'utf8'),overlaid+'// hand edit\n');
  assert.equal(await readFile(path.join(backupDir,'src/upstream.ts'),'utf8'),'upstream upstream.ts\n// hand edit\n');
  // The edited overlay file is removed so the next apply writes it again; tracked
  // files stay for checkout --force to restore.
  assert.equal(await exists(path.join(t3,'src/Overlay.ts')),false);
  assert.equal(await exists(path.join(t3,'src/CleanOverlay.ts')),true);
  assert.equal(await exists(path.join(backupDir,'src/clean-target.ts')),false);
  assert.equal(await exists(path.join(backupDir,'src/icon.png')),false);

  const again=await preserveLocalEdits({t3,backupDir:path.join(root,'backup2')});
  assert.deepEqual([...again.preserved].sort(),['src/target.ts','src/upstream.ts']);
  git('checkout','--force','HEAD');
  assert.deepEqual((await preserveLocalEdits({t3,backupDir:path.join(root,'backup3')})).preserved,[]);
});
