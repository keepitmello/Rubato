import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// ASAR's two Chromium Pickles: the header length and the JSON header.
// Preserve unpacked files, links, executable bits and untouched file contents.
export function readArchive(bytes) {
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(0) !== 4 || jsonSize > headerSize - 8 || 8 + headerSize > bytes.length) throw new Error('Invalid ASAR header');
  const json = bytes.subarray(16, 16 + jsonSize);
  const header = JSON.parse(json);
  const entry = path => path.split('/').reduce((node, name) => node?.files?.[name], header);
  return { header, headerHash: hash(json), get(path) {
    const file = entry(path);
    if (!file || file.unpacked || file.link || file.files) throw new Error(`Unsupported ASAR entry: ${path}`);
    const start = 8 + headerSize + Number(file.offset);
    if (!Number.isSafeInteger(start) || start < 8 + headerSize || start + file.size > bytes.length) throw new Error('Invalid ASAR offset');
    return bytes.subarray(start, start + file.size);
  } };
}

export function rewriteArchive(bytes, replacements) {
  const archive = readArchive(bytes), chunks = [];
  let offset = 0;
  for (const path of Object.keys(replacements)) {
    const parts = path.split('/'); let node = archive.header;
    for (const part of parts.slice(0, -1)) node = (node.files ||= {})[part] ||= { files: {} };
    (node.files ||= {})[parts.at(-1)] ||= {};
  }
  function visit(node, prefix = '') {
    for (const [name, file] of Object.entries(node.files || {})) {
      const path = prefix + name;
      if (file.files) { visit(file, path + '/'); continue; }
      if (file.unpacked || file.link) {
        if (Object.hasOwn(replacements, path)) throw new Error(`Cannot replace unpacked/link entry ${path}`);
        continue;
      }
      const data = Object.hasOwn(replacements, path) ? Buffer.from(replacements[path]) : archive.get(path);
      file.size = data.length; file.offset = String(offset); offset += data.length;
      const blockSize = 4 * 1024 * 1024;
      const blocks = [];
      for (let i = 0; i < data.length; i += blockSize) blocks.push(hash(data.subarray(i, i + blockSize)));
      file.integrity = { algorithm: 'SHA256', hash: hash(data), blockSize, blocks };
      chunks.push(data);
    }
  }
  // Read offsets from an independent original header while writing new ones.
  const originalGet = readArchive(bytes).get;
  archive.get = originalGet;
  visit(archive.header);
  const json = Buffer.from(JSON.stringify(archive.header));
  const padded = Math.ceil((json.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded + 4, 4);
  prefix.writeUInt32LE(padded, 8); prefix.writeUInt32LE(json.length, 12);
  return { bytes: Buffer.concat([prefix, json, Buffer.alloc(padded - json.length - 4), ...chunks]), headerHash: hash(json) };
}
