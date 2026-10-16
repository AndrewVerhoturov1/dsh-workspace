import type {
  CityRegion, FieldPort, Rotation, Side, TileDef, TileRegion, TileValidationCode, TileValidationError,
} from './types';
import { rotateFieldPort, rotateSide, ROTATIONS, SIDES } from './geometry';

function normalizedRegionKey(region: TileRegion, rotation: Rotation, tile: TileDef): string {
  if (region.kind === 'monastery') return 'monastery';
  if (region.kind === 'road') {
    return 'road:' + region.sides.map((side) => rotateSide(side, rotation)).sort().join(',');
  }
  if (region.kind === 'city') {
    return 'city:' + region.sides.map((side) => rotateSide(side, rotation)).sort().join(',')
      + ':shield=' + region.shields;
  }
  const cities = region.touchingCities.map((id) =>
    tile.regions.find((item): item is CityRegion => item.id === id && item.kind === 'city'))
    .filter((item): item is CityRegion => Boolean(item))
    .map((city) => normalizedRegionKey(city, rotation, tile)).sort();
  const ports = region.ports.map((port) => rotateFieldPort(port, rotation)).sort();
  return 'field:' + ports.join(',') + ':touch=' + cities.join('|');
}

export function structuralSymmetry(tile: TileDef): 1 | 2 | 4 {
  const signature = (r: Rotation) => tile.regions.map((region) => normalizedRegionKey(region, r, tile))
    .sort().join(';')
    + '|' + SIDES.map((side) => tile.edges[SIDES.indexOf(rotateSide(side, ((4 - r) % 4) as Rotation))]).join(',');
  const start = signature(0);
  if (signature(1) === start) return 4;
  if (signature(2) === start) return 2;
  return 1;
}

const PORT_PATTERN = /^[NESW]:[LR]$/;

export function validateTileDef(tile: TileDef): readonly TileValidationError[] {
  const errors: TileValidationError[] = [];
  const report = (code: TileValidationCode, path: string, message: string) =>
    errors.push({ code, path, message });

  if (!tile || typeof tile !== 'object') {
    report('INVALID_ID', '$', 'Определение плитки должно быть объектом.');
    return errors;
  }
  if (typeof tile.id !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(tile.id)) {
    report('INVALID_ID', 'id', 'Идентификатор должен содержать латинские буквы, цифры или дефисы.');
  }
  if (!Number.isInteger(tile.copies) || tile.copies < 1 || tile.copies > 72) {
    report('INVALID_COPIES', 'copies', 'Число экземпляров должно быть целым в диапазоне 1..72.');
  }
  if (!Array.isArray(tile.edges) || tile.edges.length !== 4) {
    report('INVALID_EDGE', 'edges', 'Нужно ровно четыре стороны [N,E,S,W].');
  }
  const actualEdges = Array.isArray(tile.edges) ? tile.edges : [];
  for (let i = 0; i < actualEdges.length; i++) {
    if (!['city', 'road', 'field'].includes(actualEdges[i])) {
      report('INVALID_EDGE', 'edges[' + i + ']', 'Недопустимая поверхность стороны.');
    }
  }
  if (!Array.isArray(tile.regions)) {
    report('DUPLICATE_REGION', 'regions', 'Нужен список локальных областей.');
    return errors;
  }
  const regions: readonly TileRegion[] = tile.regions;
  const seenRegionIds = new Set<string>();
  const coverage: Record<'road' | 'city', Map<Side, string>> = {
    road: new Map(), city: new Map(),
  };
  const portOwners = new Map<FieldPort, string>();
  const cityIds = new Set(regions.filter((r) => r?.kind === 'city').map((r) => r.id));
  let monasteryCount = 0;

  regions.forEach((region, i) => {
    const path = 'regions[' + i + ']';
    if (!region || typeof region !== 'object' || typeof region.id !== 'string'
      || !/^[a-z][a-z0-9-]*$/.test(region.id) || seenRegionIds.has(region.id)) {
      report('DUPLICATE_REGION', path + '.id', 'Неправильный либо повторяющийся ID области.');
      return;
    }
    seenRegionIds.add(region.id);
    const anchor = region.anchor;
    if (!anchor || typeof anchor.u !== 'number' || !Number.isFinite(anchor.u)
      || Math.abs(anchor.u) > 0.5 || typeof anchor.v !== 'number'
      || !Number.isFinite(anchor.v) || Math.abs(anchor.v) > 0.5) {
      report('INVALID_ANCHOR', path + '.anchor', 'Якорь должен лежать в квадрате [-0.5, 0.5].');
    }
    if (region.kind === 'monastery') {
      monasteryCount++;
      if (monasteryCount > 1) report('DUPLICATE_REGION', path, 'На плитке не может быть больше одного монастыря.');
    }
    if (region.kind === 'city' || region.kind === 'road') {
      const sides = region.sides;
      if (!Array.isArray(sides) || sides.length === 0) {
        report('INVALID_SIDE', path + '.sides', 'Связная область должна иметь минимум одну сторону.');
        return;
      }
      const claimed = new Set<Side>();
      sides.forEach((side, k) => {
        if (!SIDES.includes(side)) {
          report('INVALID_SIDE', path + '.sides[' + k + ']', 'Неизвестная сторона.');
        } else {
          if (claimed.has(side) || coverage[region.kind].has(side)) {
            report('DUPLICATE_SIDE', path + '.sides[' + k + ']', 'Сторона уже принадлежит другой области.');
          }
          claimed.add(side);
          coverage[region.kind].set(side, region.id);
          if (actualEdges[SIDES.indexOf(side)] !== region.kind) {
            report('INVALID_SIDE', path + '.sides[' + k + ']', 'Вид области и сторона не совпадают.');
          }
        }
      });
      if (region.kind === 'city'
        && (!Number.isInteger(region.shields) || region.shields < 0 || region.shields > 10)) {
        report('INVALID_SHIELDS', path + '.shields', 'Нужно неотрицательное целое число щитов.');
      }
    }
    if (region.kind === 'field') {
      if (!Array.isArray(region.ports)) {
        report('INVALID_PORT', path + '.ports', 'Область поля должна содержать массив портов.');
        return;
      }
      region.ports.forEach((port, k) => {
        const p = path + '.ports[' + k + ']';
        if (typeof port !== 'string' || !PORT_PATTERN.test(port)) {
          report('INVALID_PORT', p, 'Ожидается сторона N/E/S/W и полу-порт L/R.');
          return;
        }
        if (actualEdges[SIDES.indexOf(port[0] as Side)] === 'city') {
          report('INVALID_PORT', p, 'У городской грани нет полевых портов.');
        }
        const accepted = port as FieldPort;
        if (portOwners.has(accepted)) {
          report('DUPLICATE_PORT', p, 'Полу-порт уже назначен области ' + portOwners.get(accepted) + '.');
        }
        portOwners.set(accepted, region.id);
      });
      if (!Array.isArray(region.touchingCities)) {
        report('INVALID_CITY_REF', path + '.touchingCities', 'Нужен массив связанных локальных городов.');
      } else for (const [k, city] of region.touchingCities.entries()) {
        if (!cityIds.has(city) || region.touchingCities.indexOf(city) !== k) {
          report('INVALID_CITY_REF', path + '.touchingCities[' + k + ']', 'Неизвестный либо повторяющийся город.');
        }
      }
    }
  });

  for (let index = 0; index < SIDES.length; index++) {
    const side = SIDES[index]!;
    const kind: unknown = actualEdges[index];
    if (kind === 'city' || kind === 'road') {
      if (!coverage[kind].has(side)) {
        report('INVALID_SIDE', 'edges[' + index + ']', 'Сторона не принадлежит ни одной области нужного вида.');
      }
    } else if (kind === 'field') {
      // A field side is the same as two half-ports, just as for a road side.
    }
    if (kind === 'field' || kind === 'road') for (const half of ['L', 'R'] as const) {
      const port = (side + ':' + half) as FieldPort;
      if (!portOwners.has(port)) report('MISSING_PORT', 'edges[' + index + ']', 'Отсутствует порт ' + port + '.');
    }
  }
  if (![1, 2, 4].includes(tile.rotationalSymmetry)) {
    report('INVALID_SYMMETRY', 'rotationalSymmetry', 'Порядок симметрии: 1, 2 либо 4.');
  }
  // Compare actual connected components and farm/city adjacencies, not only edges.
  if (errors.length === 0 && tile.rotationalSymmetry !== structuralSymmetry(tile)) {
    report('INVALID_SYMMETRY', 'rotationalSymmetry', 'Заявленная симметрия не соответствует топологии.');
  }
  return errors;
}

export const VALID_ROTATIONS = ROTATIONS;
