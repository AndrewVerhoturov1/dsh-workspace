import type { TileCatalog, TileDef, TileRegion } from './types';
import { BASE72 } from './catalog/base72';
import { validateTileDef } from './validate';

function seal<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) seal(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalRegion(region: TileRegion): object {
  const anchor = { u: region.anchor.u, v: region.anchor.v };
  switch (region.kind) {
    case 'city':
      return { kind: region.kind, id: region.id, anchor,
        sides: [...region.sides].sort(), shields: region.shields };
    case 'road':
      return { kind: region.kind, id: region.id, anchor, sides: [...region.sides].sort() };
    case 'field':
      return { kind: region.kind, id: region.id, anchor,
        ports: [...region.ports].sort(), touchingCities: [...region.touchingCities].sort() };
    case 'monastery':
      return { kind: region.kind, id: region.id, anchor };
  }
}

export function catalogCanonicalJson(catalog: TileCatalog): string {
  return JSON.stringify({
    rulesetId: catalog.rulesetId,
    version: catalog.version,
    startTileId: catalog.startTileId,
    definitions: [...catalog.definitions].sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .map((def) => ({
        id: def.id,
        copies: def.copies,
        rotationalSymmetry: def.rotationalSymmetry,
        edges: [...def.edges],
        regions: [...def.regions].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(canonicalRegion),
      })),
  });
}

function digest64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

const CATALOG: TileCatalog = {
  rulesetId: 'base72', version: 1, startTileId: 'D', definitions: BASE72,
};

const issues = CATALOG.definitions.flatMap((def) => validateTileDef(def)
  .map((issue) => def.id + ' ' + issue.path + ': ' + issue.message));
const count = CATALOG.definitions.reduce((sum, def) => sum + def.copies, 0);
const shields = CATALOG.definitions.reduce((sum, def) =>
  sum + def.copies * def.regions.reduce((n, region) => n + (region.kind === 'city' ? region.shields : 0), 0), 0);
const unique = new Set(CATALOG.definitions.map((def) => def.id));
if (issues.length || count !== 72 || shields !== 10 || unique.size !== 24
  || !unique.has(CATALOG.startTileId)) {
  throw new Error('Invalid built-in base72 catalog: ' + [
    ...issues, 'tiles=' + count, 'shields=' + shields, 'definitions=' + unique.size,
  ].join('; '));
}

seal(CATALOG);

export const catalogDigest = digest64(catalogCanonicalJson(CATALOG));
export const definitionsById: ReadonlyMap<string, TileDef> = new Map(
  CATALOG.definitions.map((def) => [def.id, def]),
);

export function getTileCatalog(): TileCatalog {
  return CATALOG;
}
