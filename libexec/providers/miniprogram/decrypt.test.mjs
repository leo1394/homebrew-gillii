import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { decryptPackage, inspectPackage } from './decrypt.mjs';

const appid = 'wx0123456789abcdef';
const name = Buffer.from('/app.js');
const body = Buffer.alloc(1100, 0x61);
const header = Buffer.alloc(14);
header[0] = 0xbe;
header[13] = 0xed;
header.writeUInt32BE(4 + 12 + name.length, 5);
header.writeUInt32BE(body.length, 9);
const index = Buffer.alloc(4 + 12 + name.length);
index.writeUInt32BE(1, 0);
index.writeUInt32BE(name.length, 4);
name.copy(index, 8);
index.writeUInt32BE(header.length + index.length, 8 + name.length);
index.writeUInt32BE(body.length, 12 + name.length);
const plaintext = Buffer.concat([header, index, body]);
const cipher = createCipheriv('aes-256-cbc', pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1'), Buffer.from('the iv: 16 bytes'));
const encryptedHead = Buffer.concat([cipher.update(plaintext.subarray(0, 1023)), cipher.final()]);
const encryptedTail = Buffer.from(plaintext.subarray(1023));
for (let i = 0; i < encryptedTail.length; i++) encryptedTail[i] ^= appid.charCodeAt(appid.length - 2);
const encrypted = Buffer.concat([Buffer.from('V1MMWX'), encryptedHead, encryptedTail]);

test('restores exact bytes across AES/XOR boundary and validates index', () => {
  assert.deepEqual(decryptPackage(encrypted, appid), plaintext);
  assert.deepEqual(inspectPackage(plaintext), [{ name: '/app.js', offset: 37, size: 1100 }]);
});

test('rejects wrong AppID, unsupported headers and truncated packages', () => {
  assert.throws(() => decryptPackage(encrypted, 'wx1123456789abcdef'), /Invalid wxapkg/);
  assert.throws(() => decryptPackage(encrypted, 'invalid'), /AppID/);
  assert.throws(() => decryptPackage(Buffer.alloc(1100), appid), /V1MMWX/);
  assert.throws(() => decryptPackage(encrypted.subarray(0, 1029), appid), /V1MMWX/);
  assert.throws(() => decryptPackage(encrypted.subarray(0, -1), appid), /lengths/);
});

test('rejects file entries pointing outside package', () => {
  const bad = Buffer.from(plaintext);
  bad.writeUInt32BE(0xffffffff, 14 + 8 + name.length);
  assert.throws(() => inspectPackage(bad), /bounds/);
});
