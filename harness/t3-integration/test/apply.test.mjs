import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {applyIntegration} from '../apply.mjs';

test('overlay is guarded, idempotent, reversible and rejects dirty upstream before writes', {skip:!process.env.T3_SOURCE}, async(t)=>{
  const source=process.env.T3_SOURCE;
  const manifest=JSON.parse(await readFile(path.join(source,'.rubato-pi-overlay.json'),'utf8'));
  const root=await mkdtemp(path.join(tmpdir(),'rb-overlay-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [relative,entry] of Object.entries(manifest.files)) {
    await mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    if(entry.original!==null) await writeFile(path.join(root,relative),entry.original);
  }
  // A new target may not be in the previous installation's manifest yet.
  const pin=JSON.parse(await readFile(new URL('../upstream.json',import.meta.url),'utf8'));
  for(const relative of Object.keys(pin.targets)) {
    if(manifest.files[relative]) continue;
    await mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    await writeFile(path.join(root,relative),execFileSync('git',['-C',source,'show',`${pin.upstreamCommit}:${relative}`]));
  }
  // 새 overlay 파일도 포함한 이번 설치의 매니페스트와 비교한다.
  await mkdir(path.join(root,'apps/desktop/src/updates'),{recursive:true});
  await mkdir(path.join(root,'apps/web/src/components/desktop'),{recursive:true});
  const first=await applyIntegration({t3:root});
  const installed=JSON.parse(await readFile(path.join(root,'.rubato-pi-overlay.json'),'utf8'));
  assert.equal(first.changes.length,Object.keys(installed.files).length);
  assert.equal((await applyIntegration({t3:root})).changes.length,0);
  // An intact old replacement must upgrade even when the new transform can no
  // longer reverse it. The manifest hash distinguishes it from a user's edit.
  const priorTarget='apps/web/src/components/chat/MessagesTimeline.logic.ts';
  const priorText=manifest.files[priorTarget].original+'\n// previous Rubato overlay\n';
  const priorManifest=JSON.parse(await readFile(path.join(root,'.rubato-pi-overlay.json'),'utf8'));
  priorManifest.files[priorTarget].installedHash=createHash('sha256').update(priorText).digest('hex');
  await writeFile(path.join(root,priorTarget),priorText);
  await writeFile(path.join(root,'.rubato-pi-overlay.json'),JSON.stringify(priorManifest));
  assert.deepEqual((await applyIntegration({t3:root})).changes,[priorTarget]);
  assert.equal((await applyIntegration({t3:root})).changes.length,0);
  const target=path.join(root,'apps/server/src/serverRuntimeStartup.ts');
  const good=await readFile(target,'utf8');
  await writeFile(target,good+'\n// user edit\n');
  await assert.rejects(applyIntegration({t3:root}),/changed outside/);
  await assert.rejects(applyIntegration({t3:root,remove:true}),/changed outside/);
  assert.equal(await readFile(target,'utf8'),good+'\n// user edit\n');
  await writeFile(target,good);
  await applyIntegration({t3:root,remove:true});
  assert.equal(await readFile(target,'utf8'),manifest.files['apps/server/src/serverRuntimeStartup.ts'].original);
  await assert.rejects(readFile(path.join(root,'apps/server/src/provider/Drivers/RubatoPiDriver.ts')), {code:'ENOENT'});
});
