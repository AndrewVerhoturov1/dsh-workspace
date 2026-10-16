import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('standalone package declares the required runtime and test tooling', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies.react, '19.3.0');
  assert.equal(pkg.dependencies['react-dom'], '19.3.0');
  assert.equal(pkg.dependencies.three, '0.186.1');
  assert.equal(pkg.dependencies['@react-three/fiber'], '9.8.1');
  assert.equal(pkg.dependencies['@react-three/drei'], '10.7.9');
  assert.equal(pkg.devDependencies.typescript, '7.0.2');
  assert.equal(pkg.devDependencies.vite, '8.3.4');
  assert.ok(pkg.devDependencies.vitest);
  assert.ok(pkg.devDependencies['fast-check']);
  assert.ok(pkg.devDependencies['@playwright/test']);
  assert.equal(pkg.scripts.test, 'vitest run');
  assert.equal(pkg.scripts['test:e2e'], 'playwright test');
});

test('TypeScript configuration is strict and does not emit files', () => {
  const config = JSON.parse(read('tsconfig.json'));
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.moduleResolution, 'Bundler');
  assert.equal(config.compilerOptions.jsx, 'react-jsx');
});

test('foundation exposes game data types and scene callback types', () => {
  const game = read('src/game/types.ts');
  const scene = read('src/scene/types.ts');
  const gamePublic = read('src/game/index.ts');
  const scenePublic = read('src/scene/index.ts');
  for (const name of ['TileDef', 'TileCatalog', 'GameState',
    'CreateGameInput', 'TransitionResult', 'SavedGameV1', 'RestoreResult',
    'FieldRegion', 'PlayerSetup']) {
    assert.match(game, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  for (const name of ['SceneCanvasProps', 'CameraPose', 'TilePreview3DProps']) {
    assert.match(scene, new RegExp(`export interface ${name}\\b`));
  }
  assert.match(gamePublic, /export type \* from '\.\/types'/);
  assert.match(scenePublic, /export type \* from '\.\/types'/);
});

test('negative Three.js Y rotation is clockwise for x=east z=south', () => {
  const north = { x: 0, z: -1 };
  const expected = [
    { x: 0, z: -1 }, // N
    { x: 1, z: 0 },  // E
    { x: 0, z: 1 },  // S
    { x: -1, z: 0 }, // W
  ];
  for (let turns = 0; turns < 4; turns++) {
    const angle = -turns * Math.PI / 2;
    const actual = {
      x: north.x * Math.cos(angle) + north.z * Math.sin(angle),
      z: -north.x * Math.sin(angle) + north.z * Math.cos(angle),
    };
    assert.ok(Math.abs(actual.x - expected[turns].x) < 1e-12);
    assert.ok(Math.abs(actual.z - expected[turns].z) < 1e-12);
  }
});

test('Vite HTML entry and React mount point use the same root', () => {
  assert.match(read('index.html'), /id="root"/);
  assert.match(read('index.html'), /src="\/src\/main\.tsx"/);
  assert.match(read('src/main.tsx'), /getElementById\('root'\)/);
});
