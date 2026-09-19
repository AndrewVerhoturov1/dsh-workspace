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

const BASE_COMMIT = 'b2355139a16d6f13664d4a9019b50141dd432748';
const REQUEST_ID = 'REQ_TEST_001';
const EXPECTED_FILENAME = 'POSTMAN_REQ_TEST_001_RESULT.zip';
const REPOSITORY = 'AndrewVerhoturov1/dsh-workspace';

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

function makeZip(entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const spec of entries) {
    const name = spec.name;
    const nameBytes = Buffer.from(name, 'utf8');
    const localNameBytes = Buffer.from(spec.localName ?? name, 'utf8');
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.from(data);
    const flags = spec.flags ?? (1 << 11);
    const crc = spec.crcOverride ?? crc32(data);
    const declaredCompressed = spec.declaredCompressedSize ?? compressed.length;
    const declaredUncompressed = spec.declaredUncompressedSize ?? data.length;
    const versionMadeBy = spec.versionMadeBy ?? 0x0314;
    const versionNeeded = spec.versionNeeded ?? 20;
    const externalAttrs = spec.externalAttrs ?? 0;

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(versionNeeded),
      u16(flags),
      u16(method),
      u16(0), u16(0),
      u32(crc),
      u32(declaredCompressed),
      u32(declaredUncompressed),
      u16(localNameBytes.length),
      u16(0),
      localNameBytes,
      compressed,
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(versionMadeBy),
      u16(versionNeeded),
      u16(flags),
      u16(method),
      u16(0), u16(0),
      u32(crc),
      u32(declaredCompressed),
      u32(declaredUncompressed),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(externalAttrs),
      u32(offset),
      nameBytes,
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf8');
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(commentBytes.length),
    commentBytes,
  ]);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function manifest(overrides = {}) {
  return {
    protocolVersion: 1,
    requestId: REQUEST_ID,
    repository: REPOSITORY,
    baseCommit: BASE_COMMIT,
    resultType: 'patch',
    patch: 'changes.patch',
    files: [],
    ...overrides,
  };
}

function manifestEntry(value = manifest()) {
  return { name: 'manifest.json', data: JSON.stringify(value, null, 2) + '\n' };
}

const VALID_PATCH = [
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

function patchEntry(data = VALID_PATCH) {
  return { name: 'changes.patch', data };
}

function expected(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    repository: REPOSITORY,
    baseCommit: BASE_COMMIT,
    expectedFilename: EXPECTED_FILENAME,
    ...overrides,
  };
}

function withArtifact(buffer, fn, { filename = EXPECTED_FILENAME } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-postman-validator-'));
  const zipPath = path.join(dir, filename);
  fs.writeFileSync(zipPath, buffer);
  try {
    return fn(zipPath, dir);
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
  assert.deepEqual(result.warnings, []);
  return result;
}

function validPatchZip() {
  return makeZip([manifestEntry(), patchEntry()]);
}

function validFilesZip(target = 'docs/тест/данные.md', data = 'данные\n', directories = []) {
  const m = manifest({ resultType: 'files', patch: null, files: [target] });
  return makeZip([
    manifestEntry(m),
    ...directories.map((name) => ({ name, data: '' })),
    { name: `files/${target}`, data },
  ]);
}

function validArtifactZip(target = 'result.md', data = 'universal result\n') {
  const m = manifest({ resultType: 'artifact', patch: null, files: [target] });
  return makeZip([
    manifestEntry(m),
    { name: `files/${target}`, data },
  ]);
}

function validHybridZip() {
  const m = manifest({ resultType: 'hybrid_patch', files: ['src/new.txt'] });
  return makeZip([
    manifestEntry(m),
    patchEntry(),
    { name: 'files/src/new.txt', data: 'NEW\n' },
  ]);
}

test('defaults match WP-001 contract', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxCompressedBytes: 50 * 1024 * 1024,
    maxTotalUncompressedBytes: 200 * 1024 * 1024,
    maxEntryUncompressedBytes: 64 * 1024 * 1024,
    maxEntries: 2000,
    maxCompressionRatio: 100,
  });
});

for (const [name, build] of [
  ['valid manifest + patch', validPatchZip],
  ['valid universal artifact outside repository scope', () => validArtifactZip('result.md')],
  ['valid manifest + one new Unicode file', () => validFilesZip()],
  ['valid hybrid patch + files', validHybridZip],
  ['nested repo-relative paths', () => validFilesZip('docs/a/b/c.txt')],
  ['safe explicit directory entries', () => validFilesZip('docs/a/file.txt', 'x', ['files/', 'files/docs/', 'files/docs/a/'])],
]) {
  test(name, () => {
    const result = decision(build());
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.code, ARTIFACT_VALID);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.ok(result.inventory.length >= 2);
  });
}

test('deterministic decision for identical input', () => {
  const zip = validHybridZip();
  withArtifact(zip, (zipPath) => {
    const a = validateArtifact(zipPath, expected());
    const b = validateArtifact(zipPath, expected());
    assert.deepEqual(a, b);
  });
});

test('fake .zip bytes -> ARTIFACT_BAD_ZIP', () => {
  expectCode(Buffer.from('not a zip'), ERROR_CODES.BAD_ZIP);
});

test('zero-byte file -> ARTIFACT_EMPTY', () => {
  expectCode(Buffer.alloc(0), ERROR_CODES.EMPTY);
});

test('valid empty ZIP -> ARTIFACT_EMPTY', () => {
  expectCode(makeZip([]), ERROR_CODES.EMPTY);
});

test('ZIP without manifest is transport-valid', () => {
  const result = decision(makeZip([{ name: 'result.md', data: 'ok\n' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.code, ARTIFACT_VALID);
  assert.equal(result.details.manifestPresent, false);
});

test('malformed manifest JSON is informational', () => {
  const result = decision(makeZip([{ name: 'manifest.json', data: '{bad json' }, { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.ok(result.warnings.includes('manifest_json_invalid'));
});

test('non-object manifest is informational', () => {
  const result = decision(makeZip([{ name: 'manifest.json', data: '[]' }, { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.ok(result.warnings.includes('manifest_not_object'));
});

test('manifest requestId with wrong type is informational', () => {
  const result = decision(makeZip([manifestEntry({ requestId: 123, anyFutureField: true }), { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.ok(result.warnings.includes('manifest_request_id_not_string'));
});

test('manifest unknown fields are allowed', () => {
  const result = decision(makeZip([manifestEntry({ requestId: REQUEST_ID, origin_agent_id: 'informational', future: { x: 1 } }), { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('protocolVersion is informational, not a transport gate', () => {
  const result = decision(makeZip([manifestEntry({ requestId: REQUEST_ID, protocolVersion: 72 }), { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.validatedProtocolVersion, 72);
});

test('explicit wrong string requestId -> ARTIFACT_REQUEST_MISMATCH', () => {
  expectCode(makeZip([manifestEntry({ requestId: 'REQ_OTHER' }), { name: 'result.md', data: 'ok' }]), ERROR_CODES.REQUEST_MISMATCH);
});

test('repository baseCommit resultType patch and files are informational', () => {
  const m = { requestId: REQUEST_ID, repository: 'owner/other', baseCommit: 'not-a-sha', resultType: 'mystery', patch: 'missing.patch', files: ['missing.txt'] };
  const result = decision(makeZip([manifestEntry(m), { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('minimal requestId-only manifest is valid', () => {
  const result = decision(makeZip([manifestEntry({ requestId: REQUEST_ID }), { name: 'result.md', data: 'ok' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('regression: artifact manifest without protocolVersion is valid', () => {
  const m = {
    requestId: REQUEST_ID,
    repository: REPOSITORY,
    baseCommit: BASE_COMMIT,
    resultType: 'artifact',
    patch: null,
    files: ['result.md'],
  };
  const result = decision(makeZip([manifestEntry(m), { name: 'files/result.md', data: 'accepted\n' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.validatedProtocolVersion, null);
});

test('wrong archive filename -> ARTIFACT_FILENAME_MISMATCH', () => {
  expectCode(validPatchZip(), ERROR_CODES.FILENAME_MISMATCH, expected(), { filename: 'wrong.zip' });
});

for (const [fixtureName, memberName, code] of [
  ['parent traversal', '../evil', ERROR_CODES.PATH_TRAVERSAL],
  ['nested traversal', 'files/a/../../evil', ERROR_CODES.PATH_TRAVERSAL],
  ['Unix absolute', '/absolute', ERROR_CODES.ABSOLUTE_PATH],
  ['Windows drive slash', 'C:/absolute', ERROR_CODES.WINDOWS_DRIVE_PATH],
  ['Windows drive backslash', 'C:\\absolute', ERROR_CODES.WINDOWS_DRIVE_PATH],
  ['UNC backslash', '\\\\server\\share\\evil', ERROR_CODES.UNC_PATH],
  ['UNC slash', '//server/share/evil', ERROR_CODES.UNC_PATH],
  ['NTFS ADS', 'files/foo.txt:$DATA', ERROR_CODES.NTFS_ADS],
  ['Windows reserved name', 'files/CON', ERROR_CODES.WINDOWS_RESERVED_NAME],
  ['trailing dot', 'files/docs/name.', ERROR_CODES.PATH_INVALID],
  ['trailing space', 'files/docs/name ', ERROR_CODES.PATH_INVALID],
  ['control character', 'files/docs/bad\nname.txt', ERROR_CODES.PATH_INVALID],
]) {
  test(`${fixtureName} -> ${code}`, () => {
    expectCode(makeZip([manifestEntry(), patchEntry(), { name: memberName, data: 'x' }]), code);
  });
}

test('symlink ZIP entry -> ARTIFACT_SYMLINK', () => {
  const symlinkMode = (0xa000 | 0o777) << 16;
  expectCode(makeZip([
    manifestEntry(), patchEntry(),
    { name: 'files/docs/link', data: 'target', versionMadeBy: 0x0314, externalAttrs: symlinkMode >>> 0 },
  ]), ERROR_CODES.SYMLINK);
});

test('special Unix FIFO entry -> ARTIFACT_REPARSE_ENTRY', () => {
  const fifoMode = (0x1000 | 0o644) << 16;
  expectCode(makeZip([
    manifestEntry(), patchEntry(),
    { name: 'files/docs/fifo', data: '', versionMadeBy: 0x0314, externalAttrs: fifoMode >>> 0 },
  ]), ERROR_CODES.REPARSE_ENTRY);
});

test('exact duplicate normalized path -> ARTIFACT_DUPLICATE_PATH', () => {
  expectCode(makeZip([
    manifestEntry(), patchEntry(),
    { name: 'files/docs/a.md', data: 'a' },
    { name: 'files/docs/a.md', data: 'b' },
  ]), ERROR_CODES.DUPLICATE_PATH);
});

test('case-insensitive collision -> ARTIFACT_CASE_COLLISION hard reject', () => {
  const result = expectCode(makeZip([
    manifestEntry(), patchEntry(),
    { name: 'files/docs/readme.md', data: 'a' },
    { name: 'files/docs/README.md', data: 'b' },
  ]), ERROR_CODES.CASE_COLLISION);
  assert.deepEqual(result.warnings, []);
});

for (const [name, first, second] of [
  ['Latin ligature ﬀ vs ff', 'files/docs/ﬀ.txt', 'files/docs/ff.txt'],
  ['long s ſ vs s', 'files/docs/ſ.txt', 'files/docs/s.txt'],
  ['sharp s ß vs ss', 'files/docs/ß.txt', 'files/docs/ss.txt'],
  ['final sigma ς vs σ', 'files/docs/ς.txt', 'files/docs/σ.txt'],
]) {
  test(name + ' -> ARTIFACT_CASE_COLLISION', () => {
    expectCode(makeZip([
      manifestEntry(), patchEntry(),
      { name: first, data: 'a' },
      { name: second, data: 'b' },
    ]), ERROR_CODES.CASE_COLLISION);
  });
}

test('NFC-equivalent Unicode collision -> ARTIFACT_CASE_COLLISION', () => {
  expectCode(makeZip([
    manifestEntry(), patchEntry(),
    { name: 'files/docs/café.md', data: 'a' },
    { name: 'files/docs/cafe\u0301.md', data: 'b' },
  ]), ERROR_CODES.CASE_COLLISION);
});

test('repository allowlist does not constrain transport ZIP entries', () => {
  const result = decision(makeZip([{ name: 'secret/x.txt', data: 'x' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('repository forbiddenPaths do not constrain transport ZIP entries', () => {
  const result = decision(makeZip([{ name: 'settings.yaml', data: 'x' }]), expected({ allowedPaths: ['docs'], forbiddenPaths: ['settings.yaml'] }));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('actual ZIP size exceeds configured limit -> ARTIFACT_COMPRESSED_SIZE_LIMIT', () => {
  const zip = validPatchZip();
  expectCode(zip, ERROR_CODES.COMPRESSED_SIZE_LIMIT, expected({ limits: { ...DEFAULT_LIMITS, maxCompressedBytes: zip.length - 1 } }));
});

test('total uncompressed bytes exceed limit -> ARTIFACT_UNCOMPRESSED_SIZE_LIMIT', () => {
  expectCode(validPatchZip(), ERROR_CODES.UNCOMPRESSED_SIZE_LIMIT, expected({ limits: { ...DEFAULT_LIMITS, maxTotalUncompressedBytes: 100 } }));
});

test('one entry exceeds per-entry limit -> ARTIFACT_ENTRY_SIZE_LIMIT', () => {
  expectCode(validPatchZip(), ERROR_CODES.ENTRY_SIZE_LIMIT, expected({ limits: { ...DEFAULT_LIMITS, maxEntryUncompressedBytes: 10 } }));
});

test('too many entries -> ARTIFACT_ENTRY_LIMIT', () => {
  expectCode(validPatchZip(), ERROR_CODES.ENTRY_LIMIT, expected({ limits: { ...DEFAULT_LIMITS, maxEntries: 1 } }));
});

test('pathological compression ratio -> ARTIFACT_ZIP_BOMB_RISK', () => {
  const m = manifest({ resultType: 'files', patch: null, files: ['docs/bomb.txt'] });
  const zip = makeZip([
    { ...manifestEntry(m), method: 'deflate' },
    { name: 'files/docs/bomb.txt', data: 'A'.repeat(20000), method: 'deflate' },
  ]);
  expectCode(zip, ERROR_CODES.ZIP_BOMB_RISK, expected({ limits: { ...DEFAULT_LIMITS, maxCompressionRatio: 10 } }));
});

test('malformed unified diff is opaque transport payload', () => {
  const result = decision(makeZip([manifestEntry({ requestId: REQUEST_ID }), patchEntry('not-a-diff\n')]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('paths written inside patch text are not interpreted by transport validator', () => {
  const patch = '--- /absolute\n+++ ../evil\nnot-a-hunk\n';
  const result = decision(makeZip([{ name: 'changes.patch', data: patch }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('CRC mismatch is fail-closed ARTIFACT_BAD_ZIP', () => {
  expectCode(makeZip([
    { ...manifestEntry(), crcOverride: 0 },
    patchEntry(),
  ]), ERROR_CODES.BAD_ZIP);
});

test('local filename mismatch is fail-closed ARTIFACT_BAD_ZIP', () => {
  expectCode(makeZip([
    { ...manifestEntry(), localName: 'other.json' },
    patchEntry(),
  ]), ERROR_CODES.BAD_ZIP);
});

test('manifest files list does not gate extra safe payloads', () => {
  const m = { requestId: REQUEST_ID, files: ['docs/a.txt'] };
  const result = decision(makeZip([
    manifestEntry(m),
    { name: 'files/docs/a.txt', data: 'a' },
    { name: 'files/docs/extra.txt', data: 'extra' },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('safe root payload is allowed', () => {
  const result = decision(makeZip([{ name: 'surprise.txt', data: 'x' }]));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});
