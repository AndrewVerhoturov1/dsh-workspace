import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFromFiles } from '../artifact_validate_cli.mjs';

test('CLI wrapper delegates invalid bytes to canonical validator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp007-validator-cli-'));
  try {
    const expectedFilename = 'POSTMAN_REQ_TEST_001_RESULT.zip';
    const zipPath = path.join(dir, expectedFilename);
    const expectedPath = path.join(dir, 'expected.json');
    fs.writeFileSync(zipPath, 'not a zip');
    fs.writeFileSync(expectedPath, JSON.stringify({
      requestId: 'REQ_TEST_001',
      repository: 'AndrewVerhoturov1/dsh-workspace',
      baseCommit: 'a'.repeat(40),
      expectedFilename,
      allowedPaths: ['docs'],
      forbiddenPaths: ['settings.yaml']
    }));
    const result = validateFromFiles(zipPath, expectedPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARTIFACT_BAD_ZIP');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
