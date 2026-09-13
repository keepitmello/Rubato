import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
export function t3Modules(source) {
  const require = createRequire(path.join(source,'apps/server/package.json'));
  return {
    source:(relative)=>import(pathToFileURL(path.join(source,relative))),
    effect:(name)=>import(pathToFileURL(require.resolve(`effect/${name}`))),
  };
}
