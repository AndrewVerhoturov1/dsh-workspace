import type {
  Anchor, CityRegion, FieldPort, FieldRegion, MonasteryRegion, RoadRegion, Side,
  Terrain, TileDef, TileRegion,
} from '../types';
import { fieldPortAnchor, SIDE_VECTORS } from '../geometry';
import { structuralSymmetry } from '../validate';

/**
 * Base-72 C1 topology transcribed from the Big Box 2010 A-X inventory
 * (source and reconstruction limitations documented in RULES_NOTES.md).
 *
 * Side string: F=field R=road C=city, order N/E/S/W.
 * Same-kind pieces separated by "|" are NOT internally connected.
 * Field letters a..h are N:L N:R E:L E:R S:L S:R W:L W:R.
 * fieldCity: fieldIndex:cityIndex+cityIndex, comma-separated by ";".
 * Road terminals @M/@C are descriptive (monastery/city terminus) and
 * deliberately do not create artificial city/road unions.
 *
 * The particular INTERNAL farm division is a topological reconstruction,
 * not machine-readable input from the original publisher.
 */
interface Row {
  id: string;
  copies: number;
  edges: string;
  city: string;
  road: string;
  field: string;
  shields: number;
  fieldCity: string;
}

const ROWS: readonly Row[] = [
  { id: 'A', copies: 2, edges: 'FFRF', city: '-', road: 'S@M', field: 'abcdefgh', shields: 0, fieldCity: '-' },
  { id: 'B', copies: 4, edges: 'FFFF', city: '-', road: '-', field: 'abcdefgh', shields: 0, fieldCity: '-' },
  { id: 'C', copies: 1, edges: 'CCCC', city: 'NESW', road: '-', field: '-', shields: 1, fieldCity: '-' },
  { id: 'D', copies: 4, edges: 'RCRF', city: 'E', road: 'NS', field: 'afgh|be', shields: 0, fieldCity: '1:0' },
  { id: 'E', copies: 5, edges: 'CFFF', city: 'N', road: '-', field: 'cdefgh', shields: 0, fieldCity: '0:0' },
  { id: 'F', copies: 2, edges: 'FCFC', city: 'WE', road: '-', field: 'ab|ef', shields: 1, fieldCity: '0:0;1:0' },
  { id: 'G', copies: 1, edges: 'FCFC', city: 'WE', road: '-', field: 'ab|ef', shields: 0, fieldCity: '0:0;1:0' },
  { id: 'H', copies: 3, edges: 'FCFC', city: 'W|E', road: '-', field: 'abef', shields: 0, fieldCity: '0:0+1' },
  { id: 'I', copies: 2, edges: 'FCCF', city: 'E|S', road: '-', field: 'abgh', shields: 0, fieldCity: '0:0+1' },
  { id: 'J', copies: 3, edges: 'CRRF', city: 'N', road: 'ES', field: 'cfgh|de', shields: 0, fieldCity: '0:0' },
  { id: 'K', copies: 3, edges: 'RCFR', city: 'E', road: 'NW', field: 'ah|befg', shields: 0, fieldCity: '1:0' },
  { id: 'L', copies: 3, edges: 'RCRR', city: 'E', road: 'N|S|W', field: 'ah|be|fg', shields: 0, fieldCity: '1:0' },
  { id: 'M', copies: 2, edges: 'CFFC', city: 'NW', road: '-', field: 'cdef', shields: 1, fieldCity: '0:0' },
  { id: 'N', copies: 3, edges: 'CFFC', city: 'NW', road: '-', field: 'cdef', shields: 0, fieldCity: '0:0' },
  { id: 'O', copies: 2, edges: 'CRRC', city: 'NW', road: 'ES', field: 'cf|de', shields: 1, fieldCity: '0:0' },
  { id: 'P', copies: 3, edges: 'CRRC', city: 'NW', road: 'ES', field: 'cf|de', shields: 0, fieldCity: '0:0' },
  { id: 'Q', copies: 1, edges: 'CCFC', city: 'NEW', road: '-', field: 'ef', shields: 1, fieldCity: '0:0' },
  { id: 'R', copies: 3, edges: 'CCFC', city: 'NEW', road: '-', field: 'ef', shields: 0, fieldCity: '0:0' },
  { id: 'S', copies: 2, edges: 'CCRC', city: 'NEW', road: 'S@C', field: 'e|f', shields: 1, fieldCity: '0:0;1:0' },
  { id: 'T', copies: 1, edges: 'CCRC', city: 'NEW', road: 'S@C', field: 'e|f', shields: 0, fieldCity: '0:0;1:0' },
  { id: 'U', copies: 8, edges: 'RFRF', city: '-', road: 'NS', field: 'afgh|bcde', shields: 0, fieldCity: '-' },
  { id: 'V', copies: 9, edges: 'FFRR', city: '-', road: 'SW', field: 'abcdeh|fg', shields: 0, fieldCity: '-' },
  { id: 'W', copies: 4, edges: 'FRRR', city: '-', road: 'E|S|W', field: 'abch|de|fg', shields: 0, fieldCity: '-' },
  { id: 'X', copies: 1, edges: 'RRRR', city: '-', road: 'N|E|S|W', field: 'ah|bc|de|fg', shields: 0, fieldCity: '-' },
];

function componentSides(piece: string): Side[] {
  return [...piece.replace(/@.*$/, '')].map((s) => s as Side);
}

function anchorFromSides(sides: readonly Side[], kind: 'city' | 'road'): Anchor {
  if (sides.length === 0) return { u: 0, v: 0 };
  const divisor = sides.length;
  const u = sides.reduce((sum, side) => sum + SIDE_VECTORS[side].x, 0) / divisor;
  const v = sides.reduce((sum, side) => sum + SIDE_VECTORS[side].z, 0) / divisor;
  return {
    u: Math.round(u * (kind === 'city' ? 0.30 : 0.22) * 1000) / 1000,
    v: Math.round(v * (kind === 'city' ? 0.30 : 0.22) * 1000) / 1000,
  };
}

const PORT_NAMES = ['N:L', 'N:R', 'E:L', 'E:R', 'S:L', 'S:R', 'W:L', 'W:R'] as const;

function anchorFromPorts(ports: readonly FieldPort[]): Anchor {
  if (!ports.length) return { u: 0, v: 0 };
  const positions = ports.map(fieldPortAnchor);
  const u = positions.reduce((sum, p) => sum + p.u, 0) / positions.length;
  const v = positions.reduce((sum, p) => sum + p.v, 0) / positions.length;
  if (Math.hypot(u, v) < 0.08) return { u: 0.19, v: -0.19 };
  return { u: Math.round(u * 1000) / 1000, v: Math.round(v * 1000) / 1000 };
}

function createRegions(row: Row): readonly TileRegion[] {
  const cityComponents = row.city === '-' ? [] : row.city.split('|');
  const cities: CityRegion[] = cityComponents.map((piece, index) => {
    const sides = componentSides(piece);
    return {
      id: 'city-' + (index + 1),
      kind: 'city',
      sides,
      anchor: anchorFromSides(sides, 'city'),
      shields: index === 0 ? row.shields : 0,
    };
  });
  const roadComponents = row.road === '-' ? [] : row.road.split('|');
  const roads: RoadRegion[] = roadComponents.map((piece, index) => {
    const sides = componentSides(piece);
    return {
      id: 'road-' + (index + 1), kind: 'road', sides,
      anchor: anchorFromSides(sides, 'road'),
    };
  });
  const touching = new Map<number, string[]>();
  if (row.fieldCity !== '-') {
    for (const entry of row.fieldCity.split(';')) {
      const [fieldIndexString, cityIndexes] = entry.split(':');
      const fieldIndex = Number(fieldIndexString);
      const referenced = (cityIndexes ?? '').split('+').map(Number).map((n) => 'city-' + (n + 1));
      touching.set(fieldIndex, referenced);
    }
  }
  const fields: FieldRegion[] = row.field === '-' ? [] : row.field.split('|').map((piece, index) => {
    const ports = [...piece].map((letter) => PORT_NAMES[letter.charCodeAt(0) - 97]!);
    return {
      kind: 'field',
      id: 'field-' + (index + 1),
      ports,
      touchingCities: touching.get(index) ?? [],
      anchor: (row.id === 'D' || row.id === 'L') && index === 1
        ? { u: 0.22, v: -0.22 }
        : (row.id === 'O' || row.id === 'P') && index === 0
          ? { u: 0.22, v: -0.10 }
          : anchorFromPorts(ports),
    };
  });
  const monasteries: MonasteryRegion[] = row.id === 'A' || row.id === 'B'
    ? [{ id: 'monastery-1', kind: 'monastery', anchor: { u: 0, v: 0 } }]
    : [];
  return [...cities, ...roads, ...fields, ...monasteries];
}

export const BASE72: readonly TileDef[] = ROWS.map((row) => {
  const edges = [...row.edges].map((s) => ({ F: 'field', R: 'road', C: 'city' })[s] as Terrain);
  const candidate: TileDef = {
    id: row.id, copies: row.copies,
    edges: edges as unknown as TileDef['edges'], regions: createRegions(row),
    rotationalSymmetry: 1,
  };
  return { ...candidate, rotationalSymmetry: structuralSymmetry(candidate) };
});

