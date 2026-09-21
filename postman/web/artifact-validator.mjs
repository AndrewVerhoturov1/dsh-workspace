import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { TextDecoder } from 'node:util';

export const ARTIFACT_VALID = 'ARTIFACT_VALID';

// Keep the public codes stable where practical, but the validator intentionally
// emits only the small transport-safety subset used below.
export const ERROR_CODES = Object.freeze({
  BAD_ZIP: 'ARTIFACT_BAD_ZIP',
  EMPTY: 'ARTIFACT_EMPTY',
  FILENAME_MISMATCH: 'ARTIFACT_FILENAME_MISMATCH',
  PATH_TRAVERSAL: 'ARTIFACT_PATH_TRAVERSAL',
  ABSOLUTE_PATH: 'ARTIFACT_ABSOLUTE_PATH',
  WINDOWS_DRIVE_PATH: 'ARTIFACT_WINDOWS_DRIVE_PATH',
  UNC_PATH: 'ARTIFACT_UNC_PATH',
  SYMLINK: 'ARTIFACT_SYMLINK',
  COMPRESSED_SIZE_LIMIT: 'ARTIFACT_COMPRESSED_SIZE_LIMIT',
  UNCOMPRESSED_SIZE_LIMIT: 'ARTIFACT_UNCOMPRESSED_SIZE_LIMIT',
  ENTRY_SIZE_LIMIT: 'ARTIFACT_ENTRY_SIZE_LIMIT',
  ENTRY_LIMIT: 'ARTIFACT_ENTRY_LIMIT',
  ZIP_BOMB_RISK: 'ARTIFACT_ZIP_BOMB_RISK',

  // Compatibility exports retained for callers/tests that may import them.
  REQUEST_MISMATCH: 'ARTIFACT_REQUEST_MISMATCH',
  NTFS_ADS: 'ARTIFACT_NTFS_ADS',
  REPARSE_ENTRY: 'ARTIFACT_REPARSE_ENTRY',
  DUPLICATE_PATH: 'ARTIFACT_DUPLICATE_PATH',
  CASE_COLLISION: 'ARTIFACT_CASE_COLLISION',
  WINDOWS_RESERVED_NAME: 'ARTIFACT_WINDOWS_RESERVED_NAME',
  PATH_INVALID: 'ARTIFACT_PATH_INVALID',
});

export const DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 2000,
  maxCompressionRatio: 100,
});

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const UTF8_FLAG = 1 << 11;
const ENCRYPTED_FLAG = 1;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const DRIVE_RE = /^[A-Za-z]:[\\/]/;

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

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function messageFor(code) {
  return ({
    [ERROR_CODES.BAD_ZIP]: 'ZIP is malformed or cannot be read safely',
    [ERROR_CODES.EMPTY]: 'ZIP is empty',
    [ERROR_CODES.FILENAME_MISMATCH]: 'Downloaded filename does not match the expected Postman filename',
    [ERROR_CODES.PATH_TRAVERSAL]: 'ZIP contains a parent-directory traversal path',
    [ERROR_CODES.ABSOLUTE_PATH]: 'ZIP contains an absolute path',
    [ERROR_CODES.WINDOWS_DRIVE_PATH]: 'ZIP contains a Windows drive path',
    [ERROR_CODES.UNC_PATH]: 'ZIP contains a UNC path',
    [ERROR_CODES.SYMLINK]: 'ZIP contains a symbolic link entry',
    [ERROR_CODES.COMPRESSED_SIZE_LIMIT]: 'ZIP exceeds the compressed-size limit',
    [ERROR_CODES.UNCOMPRESSED_SIZE_LIMIT]: 'ZIP exceeds the total uncompressed-size limit',
    [ERROR_CODES.ENTRY_SIZE_LIMIT]: 'ZIP contains an entry that exceeds the per-entry size limit',
    [ERROR_CODES.ENTRY_LIMIT]: 'ZIP contains too many entries',
    [ERROR_CODES.ZIP_BOMB_RISK]: 'ZIP has an unsafe compression ratio',
  })[code] ?? code;
}

function bad(code, { sha256 = '', details = {}, inventory = [] } = {}) {
  return Object.freeze({
    ok: false,
    status: code,
    code,
    message: messageFor(code),
    sha256,
    validatedProtocolVersion: null,
    inventory,
    warnings: [],
    details: Object.freeze({ ...details }),
  });
}

function good(sha256, inventory) {
  return Object.freeze({
    ok: true,
    status: ARTIFACT_VALID,
    code: ARTIFACT_VALID,
    message: 'ZIP passed the minimal Postman transport validation',
    sha256,
    validatedProtocolVersion: null,
    inventory,
    warnings: [],
    details: Object.freeze({ entryCount: inventory.length }),
  });
}

function limitsOf(expectedRequest = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(expectedRequest?.limits ?? {}) };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) {
      throw new TypeError(`limits.${key} must be positive`);
    }
  }
  if (!Number.isInteger(limits.maxEntries)) throw new TypeError('limits.maxEntries must be integer');
  return limits;
}

function checkExpected(expectedRequest) {
  if (!expectedRequest || typeof expectedRequest !== 'object' || Array.isArray(expectedRequest)) {
    throw new TypeError('expectedRequest must be an object');
  }
  if (typeof expectedRequest.expectedFilename !== 'string' || !expectedRequest.expectedFilename) {
    throw new TypeError('expectedRequest.expectedFilename must be a non-empty string');
  }
}

function eocdOffset(buffer) {
  if (buffer.length < 22) return -1;
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

function decodeName(buffer, flags) {
  if (flags & UTF8_FLAG) {
    try { return UTF8.decode(buffer); } catch { return null; }
  }
  for (const byte of buffer) if (byte > 127) return null;
  return buffer.toString('ascii');
}

function classifyPath(raw) {
  if (typeof raw !== 'string' || !raw) return { ok: false, code: ERROR_CODES.BAD_ZIP, reason: 'empty_name' };
  if (/^[\\/]{2}/.test(raw)) return { ok: false, code: ERROR_CODES.UNC_PATH, reason: 'unc' };
  if (DRIVE_RE.test(raw)) return { ok: false, code: ERROR_CODES.WINDOWS_DRIVE_PATH, reason: 'drive' };
  if (/^[\\/]/.test(raw)) return { ok: false, code: ERROR_CODES.ABSOLUTE_PATH, reason: 'absolute' };

  const normalized = raw.replaceAll('\\', '/');
  const directory = normalized.endsWith('/');
  const body = directory ? normalized.slice(0, -1) : normalized;
  const parts = body.split('/');
  if (!body || parts.some((part) => part === '')) return { ok: false, code: ERROR_CODES.BAD_ZIP, reason: 'empty_segment' };
  if (parts.some((part) => part === '..')) return { ok: false, code: ERROR_CODES.PATH_TRAVERSAL, reason: 'dotdot' };
  if (parts.some((part) => part === '.')) return { ok: false, code: ERROR_CODES.BAD_ZIP, reason: 'dot_segment' };
  return { ok: true, normalized: body + (directory ? '/' : ''), isDirectory: directory };
}

function isSymlink(versionMadeBy, externalAttrs) {
  const platform = versionMadeBy >>> 8;
  if (platform !== 3) return false;
  const mode = (externalAttrs >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

function parseCentral(buffer) {
  const eocd = eocdOffset(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) return { error: 'eocd' };

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const onDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);

  if (eocd + 22 + commentLength !== buffer.length) return { error: 'trailing_data' };
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count) return { error: 'multi_disk' };
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return { error: 'zip64' };
  if (centralOffset + centralSize !== eocd) return { error: 'central_bounds' };

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL) return { error: 'central_header', index };
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLen;
    if (end > eocd || diskStart !== 0) return { error: 'central_entry', index };
    if (flags & ENCRYPTED_FLAG) return { error: 'encrypted', index };
    if (method !== 0 && method !== 8) return { error: 'compression_method', index };

    const nameBytes = Buffer.from(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    const rawName = decodeName(nameBytes, flags);
    if (rawName === null) return { error: 'filename_encoding', index };
    entries.push({
      versionMadeBy,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      nameBytes,
      rawName,
      externalAttrs,
      localOffset,
    });
    cursor = end;
  }
  if (cursor !== eocd) return { error: 'central_size' };
  return { entries, centralOffset };
}

function readEntryData(buffer, entry, centralOffset, maxEntryBytes) {
  const cursor = entry.localOffset;
  if (cursor + 30 > centralOffset || buffer.readUInt32LE(cursor) !== LOCAL) return { error: 'local_header' };
  const flags = buffer.readUInt16LE(cursor + 6);
  const method = buffer.readUInt16LE(cursor + 8);
  const nameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  const nameStart = cursor + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if ((flags & ENCRYPTED_FLAG) || method !== entry.method || dataEnd > centralOffset) return { error: 'local_mismatch' };
  if (!Buffer.from(buffer.subarray(nameStart, nameStart + nameLength)).equals(entry.nameBytes)) return { error: 'local_name' };

  let data;
  try {
    data = entry.method === 0
      ? Buffer.from(buffer.subarray(dataStart, dataEnd))
      : zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: maxEntryBytes + 1 });
  } catch (error) {
    return { error: 'inflate', message: String(error?.message ?? error).slice(0, 300) };
  }
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) return { error: 'size_or_crc' };
  return { data };
}

export function validateArtifact(zipPath, expectedRequest) {
  checkExpected(expectedRequest);
  const limits = limitsOf(expectedRequest);

  let stat;
  try { stat = fs.statSync(zipPath); } catch (error) {
    return bad(ERROR_CODES.BAD_ZIP, { details: { reason: 'file_missing', message: String(error?.message ?? error) } });
  }
  if (!stat.isFile()) return bad(ERROR_CODES.BAD_ZIP, { details: { reason: 'not_file' } });
  if (stat.size === 0) return bad(ERROR_CODES.EMPTY, { details: { reason: 'zero_byte' } });
  if (path.basename(zipPath) !== expectedRequest.expectedFilename) {
    return bad(ERROR_CODES.FILENAME_MISMATCH, {
      details: { actual: path.basename(zipPath), expected: expectedRequest.expectedFilename },
    });
  }
  if (stat.size > limits.maxCompressedBytes) {
    return bad(ERROR_CODES.COMPRESSED_SIZE_LIMIT, { details: { actual: stat.size, limit: limits.maxCompressedBytes } });
  }

  let buffer;
  try { buffer = fs.readFileSync(zipPath); } catch (error) {
    return bad(ERROR_CODES.BAD_ZIP, { details: { reason: 'read', message: String(error?.message ?? error) } });
  }
  const zipHash = hash(buffer);
  const parsed = parseCentral(buffer);
  if (parsed.error) return bad(ERROR_CODES.BAD_ZIP, { sha256: zipHash, details: parsed });
  if (parsed.entries.length === 0) return bad(ERROR_CODES.EMPTY, { sha256: zipHash, details: { reason: 'empty_zip' } });
  if (parsed.entries.length > limits.maxEntries) {
    return bad(ERROR_CODES.ENTRY_LIMIT, {
      sha256: zipHash,
      details: { actual: parsed.entries.length, limit: limits.maxEntries },
    });
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  const inventory = [];

  for (const entry of parsed.entries) {
    const classified = classifyPath(entry.rawName);
    if (!classified.ok) {
      return bad(classified.code, { sha256: zipHash, inventory, details: { path: entry.rawName, reason: classified.reason } });
    }
    if (isSymlink(entry.versionMadeBy, entry.externalAttrs)) {
      return bad(ERROR_CODES.SYMLINK, { sha256: zipHash, inventory, details: { path: classified.normalized } });
    }
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      return bad(ERROR_CODES.ENTRY_SIZE_LIMIT, {
        sha256: zipHash,
        inventory,
        details: { path: classified.normalized, actual: entry.uncompressedSize, limit: limits.maxEntryUncompressedBytes },
      });
    }

    totalUncompressed += entry.uncompressedSize;
    totalCompressed += entry.compressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      return bad(ERROR_CODES.UNCOMPRESSED_SIZE_LIMIT, {
        sha256: zipHash,
        inventory,
        details: { actual: totalUncompressed, limit: limits.maxTotalUncompressedBytes },
      });
    }
    const ratio = entry.uncompressedSize === 0
      ? 1
      : (entry.compressedSize === 0 ? Infinity : entry.uncompressedSize / entry.compressedSize);
    if (ratio > limits.maxCompressionRatio) {
      return bad(ERROR_CODES.ZIP_BOMB_RISK, {
        sha256: zipHash,
        inventory,
        details: { path: classified.normalized, ratio, limit: limits.maxCompressionRatio },
      });
    }

    const data = readEntryData(buffer, entry, parsed.centralOffset, limits.maxEntryUncompressedBytes);
    if (data.error) {
      return bad(ERROR_CODES.BAD_ZIP, {
        sha256: zipHash,
        inventory,
        details: { path: classified.normalized, ...data },
      });
    }
    inventory.push(Object.freeze({
      path: classified.normalized,
      kind: classified.isDirectory ? 'directory' : 'file',
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    }));
  }

  const aggregateRatio = totalUncompressed === 0
    ? 1
    : (totalCompressed === 0 ? Infinity : totalUncompressed / totalCompressed);
  if (aggregateRatio > limits.maxCompressionRatio) {
    return bad(ERROR_CODES.ZIP_BOMB_RISK, {
      sha256: zipHash,
      inventory,
      details: { aggregateRatio, limit: limits.maxCompressionRatio },
    });
  }

  return good(zipHash, inventory);
}
