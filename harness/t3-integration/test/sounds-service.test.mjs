import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoundsService, handleSoundsRequest } from '../src/sounds/service.mjs';

// The sounds a thread notification can play besides T3's own (sound-edits.mjs).

// A one-sample 8 kHz mono 16-bit WAV: enough for the routes, which never decode.
function wav() {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(38, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(2, 40);
  return Buffer.concat([header, Buffer.alloc(2)]);
}

const post = (action, body) => new Request(`http://local/rubato/sounds/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-sounds-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folders = { system: path.join(root, 'system'), local: path.join(root, 'missing'), user: path.join(root, 'user') };
  await mkdir(folders.system);
  await mkdir(folders.user);
  await writeFile(path.join(folders.system, 'Ping.wav'), wav());
  await writeFile(path.join(folders.system, 'Glass.wav'), wav());
  await writeFile(path.join(folders.system, 'readme.txt'), 'not a sound');
  await writeFile(path.join(folders.system, '.Hidden.wav'), wav());
  await writeFile(path.join(folders.user, 'Mine.mp3'), wav());
  await writeFile(path.join(root, 'secret.wav'), wav());
  return { root, folders, cacheDirectory: path.join(root, 'cache') };
}

test('lists audio files, system sounds first and each folder by name', async (t) => {
  const { folders } = await fixture(t);
  assert.deepEqual(await createSoundsService({ folders }).list(), [
    { id: 'mac:system/Glass.wav', name: 'Glass', folder: 'system' },
    { id: 'mac:system/Ping.wav', name: 'Ping', folder: 'system' },
    { id: 'mac:user/Mine.mp3', name: 'Mine', folder: 'user' },
  ]);
});

test('resolves only ids the listing returns', async (t) => {
  const { root, folders } = await fixture(t);
  const service = createSoundsService({ folders });
  assert.equal(await service.resolve('mac:system/Ping.wav'), path.join(folders.system, 'Ping.wav'));
  for (const id of ['mac:system/../secret.wav', 'mac:user/../secret.wav', 'mac:system/readme.txt',
    'mac:system/.Hidden.wav', 'mac:other/Ping.wav', 'builtin:completion', undefined, 42])
    assert.equal(await service.resolve(id), null, String(id));
  await mkdir(path.join(folders.user, 'Folder.wav'));
  assert.equal(await service.resolve('mac:user/Folder.wav'), null);
  // A link the user put in their own sounds folder is theirs to choose.
  await symlink(path.join(root, 'secret.wav'), path.join(folders.user, 'Linked.wav'));
  assert.equal(await service.resolve('mac:user/Linked.wav'), path.join(folders.user, 'Linked.wav'));
});

test('answers list and file, and refuses an id it did not list', async (t) => {
  const { folders } = await fixture(t);
  const service = createSoundsService({ folders });
  const listed = await handleSoundsRequest(service, post('list'));
  assert.equal((await listed.json()).sounds.length, 3);

  const file = await handleSoundsRequest(service, post('file', { id: 'mac:system/Ping.wav' }));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'audio/wav');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(wav()));

  for (const body of [{ id: 'mac:system/../secret.wav' }, {}]) {
    const refused = await handleSoundsRequest(service, post('file', body));
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).error.code, 'unknown-sound');
  }
  assert.equal((await handleSoundsRequest(service, post('nope'))).status, 404);
  assert.equal((await handleSoundsRequest(service, new Request('http://local/rubato/sounds/list'))).status, 405);
});

test('converts an AIFF once and serves the cached WAV after', async (t) => {
  const { folders, cacheDirectory } = await fixture(t);
  await writeFile(path.join(folders.system, 'Funk.aiff'), 'aiff bytes');
  let conversions = 0;
  const convert = async (input, output) => {
    conversions += 1;
    await writeFile(output, wav());
  };
  const service = createSoundsService({ folders, cacheDirectory, convert });
  for (let round = 0; round < 2; round += 1) {
    const { bytes, contentType } = await service.file('mac:system/Funk.aiff');
    assert.equal(contentType, 'audio/wav');
    assert.ok(Buffer.from(bytes).equals(wav()));
  }
  assert.equal(conversions, 1);
  assert.deepEqual((await readdir(cacheDirectory)).filter((name) => name.includes('.tmp.')), []);
});

test('a failed conversion answers 500 and leaves no partial file', async (t) => {
  const { folders, cacheDirectory } = await fixture(t);
  await writeFile(path.join(folders.system, 'Broken.caf'), 'caf bytes');
  const convert = async (_input, output) => {
    await writeFile(output, 'half');
    throw new Error('afconvert failed');
  };
  const response = await handleSoundsRequest(createSoundsService({ folders, cacheDirectory, convert }),
    post('file', { id: 'mac:system/Broken.caf' }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'convert-failed');
  assert.deepEqual(await readdir(cacheDirectory), []);
});

test('converts a real macOS alert sound to WAV', { skip: process.platform !== 'darwin' }, async (t) => {
  const { folders, cacheDirectory } = await fixture(t);
  const service = createSoundsService({ folders: { ...folders, system: '/System/Library/Sounds' }, cacheDirectory });
  const { bytes, contentType } = await service.file('mac:system/Glass.aiff');
  assert.equal(contentType, 'audio/wav');
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), 'RIFF');
  assert.equal(Buffer.from(bytes).subarray(8, 12).toString(), 'WAVE');
});
