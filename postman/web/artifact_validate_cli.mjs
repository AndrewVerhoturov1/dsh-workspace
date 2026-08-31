#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateArtifact } from './artifact-validator.mjs';

export function validateFromFiles(zipPath, expectedPath) {
  const expectedText = fs.readFileSync(expectedPath, 'utf8');
  const expected = JSON.parse(expectedText);
  return validateArtifact(zipPath, expected);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) throw new Error(`missing ${name}`);
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  try {
    const zipPath = argValue(argv, '--zip');
    const expectedPath = argValue(argv, '--expected');
    const result = validateFromFiles(zipPath, expectedPath);
    process.stdout.write(JSON.stringify(result) + '\n');
    return result?.ok === true ? 0 : 3;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: 'ARTIFACT_VALIDATOR_CLI_FAILED',
      status: 'ARTIFACT_VALIDATOR_CLI_FAILED',
      details: { message: String(error?.message ?? error).slice(0, 1000) }
    }) + '\n');
    return 2;
  }
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) process.exitCode = main();
