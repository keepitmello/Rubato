import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overlay = fileURLToPath(new URL('../overlay', import.meta.url));
const driverSrc = readFileSync(path.join(overlay, 'apps/server/src/provider/Drivers/RubatoPiDriver.ts'), 'utf8');
const inventorySrc = readFileSync(path.join(overlay, 'apps/server/src/provider/RubatoPiInventory.ts'), 'utf8');

function isAbsoluteLocalPath(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

test('Windows drive letters, UNC, and Unix roots are absolute local paths', () => {
  assert.equal(isAbsoluteLocalPath('/Users/wy/proj'), true);
  assert.equal(isAbsoluteLocalPath('/'), true);
  assert.equal(isAbsoluteLocalPath('C:\\Users\\wy\\proj'), true);
  assert.equal(isAbsoluteLocalPath('C:/Users/wy/proj'), true);
  assert.equal(isAbsoluteLocalPath('d:\\work'), true);
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\repo'), true);
  assert.equal(isAbsoluteLocalPath('//server/share/repo'), true);
  assert.equal(isAbsoluteLocalPath('relative'), false);
  assert.equal(isAbsoluteLocalPath('foo/bar'), false);
  assert.equal(isAbsoluteLocalPath('foo\\bar'), false);
  assert.equal(isAbsoluteLocalPath(''), false);
  assert.equal(isAbsoluteLocalPath('file:///C:/repo/bridge.mjs'), false);
});

test('driver rejects slash-prefix-only checks and accepts Windows absolute paths', () => {
  assert.match(driverSrc, /export const isAbsoluteLocalPath/);
  assert.match(driverSrc, /NodePath\.posix\.isAbsolute\(value\) \|\| NodePath\.win32\.isAbsolute\(value\)/);
  assert.doesNotMatch(driverSrc, /bridgeModule\.startsWith\("\/"\)/);
  assert.doesNotMatch(driverSrc, /descriptorPath\.startsWith\("\/"\)/);
  assert.doesNotMatch(driverSrc, /catalogueCwd\.startsWith\("\/"\)/);
  assert.match(driverSrc, /isAbsoluteLocalPath\(config\.bridgeModule\)/);
  assert.match(driverSrc, /isAbsoluteLocalPath\(config\.descriptorPath\)/);
  assert.match(driverSrc, /isAbsoluteLocalPath\(config\.catalogueCwd\)/);
  assert.match(driverSrc, /startsWith\("file:\/\/\/"\)/);
});

test('inventory keeps Windows cwd sessions instead of requiring a leading slash', () => {
  assert.match(inventorySrc, /isAbsoluteLocalPath\(entry\.cwd\)/);
  assert.doesNotMatch(inventorySrc, /entry\.cwd\.startsWith\("\/"\)/);
  assert.ok(inventorySrc.includes('split(/['), inventorySrc);
});
