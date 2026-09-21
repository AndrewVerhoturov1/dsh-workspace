import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  ARTIFACT_VALID,
  DEFAULT_LIMITS,
  ERROR_CODES,
  validateArtifact,
} from '../artifact-validator.mjs';

const EXPECTED_FILENAME = 'POSTMAN_REQ_TEST_001_RESULT.zip';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const spec of entries) {
    const nameBytes = Buffer.from(spec.name, 'utf8');
    const localNameBytes = Buffer.from(spec.localName ?? spec.name, 'utf8');
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.from(data);
    const flags = spec.flags ?? (1 << 11);
    const crc = spec.crcOverride ?? crc32(data);
    const externalAttrs = spec.externalAttrs ?? 0;
    const versionMadeBy = spec.versionMadeBy ?? 0x0314;
    const declaredCompressed = spec.declaredCompressedSize ?? compressed.length;
    const declaredUncompressed = spec.declaredUncompressedSize ?? data.length;

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(declaredCompressed), u32(declaredUncompressed),
      u16(localNameBytes.length), u16(0), localNameBytes, compressed,
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50), u16(versionMadeBy), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(declaredCompressed), u32(declaredUncompressed),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(externalAttrs), u32(offset), nameBytes,
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function expected(overrides = {}) {
  return {
    expectedFilename: EXPECTED_FILENAME,
    requestId: 'REQ_TEST_001',
    repository: 'ignored/by/minimal-validator',
    baseCommit: 'not-a-transport-gate',
    ...overrides,
  };
}

function withArtifact(buffer, fn, { filename = EXPECTED_FILENAME } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-simple-validator-'));
  const zipPath = path.join(dir, filename);
  fs.writeFileSync(zipPath, buffer);
  try {
    return fn(zipPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function decision(buffer, expectedRequest = expected(), options = {}) {
  return withArtifact(buffer, (zipPath) => validateArtifact(zipPath, expectedRequest), options);
}

function expectCode(buffer, code, expectedRequest = expected(), options = {}) {
  const result = decision(buffer, expectedRequest, options);
  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  assert.equal(result.code, code, JSON.stringify(result, null, 2));
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  return result;
}

test('defaults remain bounded and simple', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxCompressedBytes: 50 * 1024 * 1024,
    maxTotalUncompressedBytes: 200 * 1024 * 1024,
    maxEntryUncompressedBytes: 64 * 1024 * 1024,
    maxEntries: 2000,
    maxCompressionRatio: 100,
  });
});

test('ordinary readable ZIP is valid without manifest semantics', () => {
  const result = decision(makeZip([
    { name: 'result.md', data: 'ok\n' },
    { name: 'manifest.json', data: '{ definitely not JSON' },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.code, ARTIFACT_VALID);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.inventory.length, 2);
});

test('manifest requestId and repository are not transport gates', () => {
  const result = decision(makeZip([
    { name: 'manifest.json', data: JSON.stringify({ requestId: 'REQ_OTHER', repository: 'x/y' }) },
    { name: 'result.md', data: 'ok\n' },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('fake bytes are rejected as bad ZIP', () => {
  expectCode(Buffer.from('not a zip'), ERROR_CODES.BAD_ZIP);
});

test('zero-byte archive is rejected', () => {
  expectCode(Buffer.alloc(0), ERROR_CODES.EMPTY);
});

test('empty ZIP is rejected', () => {
  expectCode(makeZip([]), ERROR_CODES.EMPTY);
});

test('wrong downloaded filename is rejected', () => {
  expectCode(makeZip([{ name: 'result.md', data: 'ok' }]), ERROR_CODES.FILENAME_MISMATCH, expected(), { filename: 'wrong.zip' });
});

for (const [name, memberName, code] of [
  ['parent traversal', '../evil.txt', ERROR_CODES.PATH_TRAVERSAL],
  ['nested traversal', 'files/a/../../evil.txt', ERROR_CODES.PATH_TRAVERSAL],
  ['Unix absolute path', '/tmp/evil.txt', ERROR_CODES.ABSOLUTE_PATH],
  ['Windows drive path', 'C:/evil.txt', ERROR_CODES.WINDOWS_DRIVE_PATH],
  ['UNC path', '//server/share/evil.txt', ERROR_CODES.UNC_PATH],
]) {
  test(`${name} is rejected`, () => {
    expectCode(makeZip([{ name: memberName, data: 'x' }]), code);
  });
}

test('symlink entry is rejected', () => {
  const symlinkMode = (0xa000 | 0o777) << 16;
  expectCode(makeZip([
    { name: 'link', data: 'target', versionMadeBy: 0x0314, externalAttrs: symlinkMode >>> 0 },
  ]), ERROR_CODES.SYMLINK);
});

test('CRC corruption is rejected as bad ZIP', () => {
  expectCode(makeZip([{ name: 'result.md', data: 'ok', crcOverride: 0 }]), ERROR_CODES.BAD_ZIP);
});

test('local filename mismatch is rejected as bad ZIP', () => {
  expectCode(makeZip([{ name: 'result.md', localName: 'other.md', data: 'ok' }]), ERROR_CODES.BAD_ZIP);
});

test('compressed size limit is enforced', () => {
  const zip = makeZip([{ name: 'result.md', data: 'ok' }]);
  expectCode(zip, ERROR_CODES.COMPRESSED_SIZE_LIMIT, expected({
    limits: { ...DEFAULT_LIMITS, maxCompressedBytes: zip.length - 1 },
  }));
});

test('total uncompressed size limit is enforced', () => {
  expectCode(makeZip([{ name: 'result.md', data: '0123456789' }]), ERROR_CODES.UNCOMPRESSED_SIZE_LIMIT, expected({
    limits: { ...DEFAULT_LIMITS, maxTotalUncompressedBytes: 5 },
  }));
});

test('entry count limit is enforced', () => {
  expectCode(makeZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }]), ERROR_CODES.ENTRY_LIMIT, expected({
    limits: { ...DEFAULT_LIMITS, maxEntries: 1 },
  }));
});

test('pathological compression ratio is rejected', () => {
  expectCode(makeZip([{ name: 'bomb.txt', data: 'A'.repeat(20000), method: 'deflate' }]), ERROR_CODES.ZIP_BOMB_RISK, expected({
    limits: { ...DEFAULT_LIMITS, maxCompressionRatio: 10 },
  }));
});
