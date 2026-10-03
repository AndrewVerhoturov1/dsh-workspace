import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
});


export function validateArtifact(zipPath, expectedRequest) {
  if (!expectedRequest || typeof expectedRequest.expectedFilename !== 'string' || !expectedRequest.expectedFilename)
    throw new TypeError('expectedRequest.expectedFilename must be a non-empty string');
  const limits = { ...DEFAULT_LIMITS, ...(expectedRequest.limits ?? {}) };
  for (const key of Object.keys(DEFAULT_LIMITS))
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new TypeError('limits.' + key + ' must be a positive integer');
  let result;
  if (path.basename(zipPath) !== expectedRequest.expectedFilename) result = { ok:false, code:ERROR_CODES.FILENAME_MISMATCH };
  else if (!fs.existsSync(zipPath)) result = { ok:false, code:ERROR_CODES.NOT_FOUND };
  else if (!fs.statSync(zipPath).size) result = { ok:false, code:ERROR_CODES.EMPTY };
  else {
    const helper = fileURLToPath(new URL('../safe_zip.py', import.meta.url));
    const run = spawnSync(process.env.POSTMAN_PYTHON ?? 'python', ['-X', 'utf8', helper, zipPath, '--limits', JSON.stringify(limits)],
      { encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:4*1024*1024 });
    try { result = JSON.parse(run.stdout); }
    catch { result = { ok:false, code:ERROR_CODES.BAD_ZIP, details:{ reason:'safe_zip_reader_failed' } }; }
  }
  return Object.freeze({ ...result, status:result.code, sha256:result.sha256 ?? null,
    inventory:result.inventory ?? [], warnings:[], validatedProtocolVersion:null,
    message:result.ok ? 'ZIP passed minimal Postman transport validation' : result.code,
    details:Object.freeze(result.details ?? { entryCount:result.inventory?.length ?? 0 }) });
}
