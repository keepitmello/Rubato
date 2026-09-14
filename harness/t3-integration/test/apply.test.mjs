import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
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
  // 설치된 매니페스트가 정본이다. 숫자를 박아 두면 파일을 하나 더 손댈 때마다 시험이 먼저 썩는다.
  const first=await applyIntegration({t3:root}); assert.equal(first.changes.length,Object.keys(manifest.files).length);
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
