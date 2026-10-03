import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('V1MMWX');

export function inspectPackage(data) {
  if (data.length < 18 || data[0] !== 0xbe || data[13] !== 0xed) {
    throw new Error('Invalid wxapkg header: incorrect AppID or unsupported package format.');
  }
  const indexLength = data.readUInt32BE(5);
  const bodyLength = data.readUInt32BE(9);
  const indexEnd = 14 + indexLength;
  if (indexLength < 4 || indexEnd + bodyLength !== data.length) {
    throw new Error('Invalid wxapkg index/body lengths.');
  }
  const count = data.readUInt32BE(14);
  if (count > Math.floor((indexLength - 4) / 12)) {
    throw new Error('Invalid wxapkg file count.');
  }
  const files = [];
  let cursor = 18;
  for (let i = 0; i < count; i++) {
    if (cursor + 4 > indexEnd) throw new Error('Truncated file index.');
    const nameLength = data.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + nameLength + 8 > indexEnd) throw new Error('Truncated file entry.');
    const name = data.subarray(cursor, cursor + nameLength).toString('utf8');
    cursor += nameLength;
    const offset = data.readUInt32BE(cursor);
    const size = data.readUInt32BE(cursor + 4);
    cursor += 8;
    if (offset < indexEnd || offset + size > data.length) {
      throw new Error(`Invalid file bounds: ${name}`);
    }
    files.push({ name, offset, size });
  }
  if (cursor !== indexEnd) throw new Error('Unexpected trailing file index data.');
  return files;
}

export function decryptPackage(data, appid) {
  if (!/^wx[0-9a-f]{16}$/.test(appid)) throw new Error('AppID must be wx followed by 16 lowercase hex digits.');
  if (data.length < 1030 || !data.subarray(0, 6).equals(MAGIC)) {
    throw new Error('Expected a V1MMWX encrypted package of at least 1030 bytes.');
  }
  const key = pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const cipher = createDecipheriv('aes-256-cbc', key, Buffer.from('the iv: 16 bytes'));
  cipher.setAutoPadding(false);
  const head = Buffer.concat([cipher.update(data.subarray(6, 1030)), cipher.final()]);
  const tail = Buffer.from(data.subarray(1030));
  const xorKey = appid.charCodeAt(appid.length - 2);
  for (let i = 0; i < tail.length; i++) tail[i] ^= xorKey;
  const plaintext = Buffer.concat([head.subarray(0, 1023), tail]);
  inspectPackage(plaintext);
  return plaintext;
}

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node decrypt.mjs <AppID> <encrypted.wxapkg> <output.wxapkg>');
    return;
  }
  if (args.length !== 3) throw new Error('Usage: node decrypt.mjs <AppID> <encrypted.wxapkg> <output.wxapkg>');
  const [appid, input, output] = args;
  if (resolve(input) === resolve(output)) throw new Error('Input and output must be different paths.');
  const plaintext = decryptPackage(readFileSync(input), appid);
  writeFileSync(output, plaintext, { flag: 'wx', mode: 0o600 });
  console.log(`Decrypted: ${resolve(output)} (${plaintext.length} bytes, ${inspectPackage(plaintext).length} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
