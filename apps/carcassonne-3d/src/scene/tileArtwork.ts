import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import type { Anchor, Side, Terrain, TileDef, TileRegion } from '../game';

/**
 * Original deterministic ink-and-gouache artwork. Every sample at a tile edge
 * uses only that edge's terrain (and an invariant corner), never its tile ID.
 * Geometry/ports are taken from the supplied topology, not inferred as rules.
 */
const SIDE_ORDER: readonly Side[] = ['N', 'E', 'S', 'W'];
const EDGE_WIDTH = 0.145;
const EDGE_CORNER = 0.044;
const BAND = 0.033;
const textureCache = new Map<string, CanvasTexture>();
const canvasCache = new Map<string, HTMLCanvasElement>();

type Pt = { x: number; z: number };

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomGenerator(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function edgeTerrainAt(terrain: Terrain, along: number): 'corner' | Terrain {
  if (Math.abs(along) >= 0.5 - EDGE_CORNER) return 'corner';
  if (terrain === 'road') return Math.abs(along) < EDGE_WIDTH / 2 ? 'road' : 'field';
  return terrain;
}

export function sideCentre(side: Side): Pt {
  switch (side) {
    case 'N': return { x: 0, z: -0.5 };
    case 'E': return { x: 0.5, z: 0 };
    case 'S': return { x: 0, z: 0.5 };
    case 'W': return { x: -0.5, z: 0 };
  }
}

function sideTangent(side: Side): Pt {
  return side === 'N' || side === 'S' ? { x: 1, z: 0 } : { x: 0, z: 1 };
}

export function fieldPortPosition(port: string): Pt {
  const side = port.slice(0, 1) as Side;
  const arm = port.slice(2) === 'L' ? -0.31 : 0.31;
  switch (side) {
    case 'N': return { x: arm, z: -0.465 };
    case 'E': return { x: 0.465, z: arm };
    case 'S': return { x: -arm, z: 0.465 };
    case 'W': return { x: -0.465, z: -arm };
    default: return { x: 0, z: 0 };
  }
}

export function localAnchor(anchor: Anchor): Pt {
  return { x: Math.max(-0.43, Math.min(0.43, anchor.u)), z: Math.max(-0.43, Math.min(0.43, anchor.v)) };
}

function cityPath(ctx: CanvasRenderingContext2D, region: Extract<TileRegion, { kind: 'city' }>): void {
  const hub = localAnchor(region.anchor);
  ctx.beginPath();
  if (region.sides.length === 0) {
    ctx.arc(hub.x, hub.z, 0.205, 0, Math.PI * 2);
    return;
  }
  for (const side of region.sides) {
    const edge = sideCentre(side);
    const tangent = sideTangent(side);
    const near = { x: edge.x * 0.53 + hub.x * 0.47, z: edge.z * 0.53 + hub.z * 0.47 };
    const ax = edge.x - tangent.x * 0.51;
    const az = edge.z - tangent.z * 0.51;
    const bx = edge.x + tangent.x * 0.51;
    const bz = edge.z + tangent.z * 0.51;
    ctx.moveTo(ax, az);
    ctx.lineTo(bx, bz);
    ctx.bezierCurveTo(
      near.x + tangent.x * 0.32, near.z + tangent.z * 0.32,
      hub.x + tangent.x * 0.23, hub.z + tangent.z * 0.23,
      hub.x + tangent.x * 0.16, hub.z + tangent.z * 0.16,
    );
    ctx.quadraticCurveTo(hub.x, hub.z, hub.x - tangent.x * 0.16, hub.z - tangent.z * 0.16);
    ctx.bezierCurveTo(
      hub.x - tangent.x * 0.23, hub.z - tangent.z * 0.23,
      near.x - tangent.x * 0.32, near.z - tangent.z * 0.32,
      ax, az,
    );
    ctx.closePath();
  }
  ctx.moveTo(hub.x + 0.20, hub.z);
  ctx.arc(hub.x, hub.z, 0.20, 0, Math.PI * 2);
}

/**
 * Partition separate local components of the same terrain.
 * An intentional pasture gap remains between nearby disjoint components.
 * Canonical edge strips are repainted afterward and always take precedence.
 */
function clipIndependentRegion(
  ctx: CanvasRenderingContext2D,
  self: Extract<TileRegion, { kind: 'road' | 'city' }>,
  peers: readonly Extract<TileRegion, { kind: 'road' | 'city' }>[],
): void {
  const a = localAnchor(self.anchor);
  for (const peer of peers) {
    if (peer.id === self.id) continue;
    const b = localAnchor(peer.anchor);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.0001) continue;
    const limit = (b.x * b.x + b.z * b.z - a.x * a.x - a.z * a.z) / 2 - length * 0.012;
    const polygon: Pt[] = [
      { x: -0.52, z: -0.52 }, { x: 0.52, z: -0.52 },
      { x: 0.52, z: 0.52 }, { x: -0.52, z: 0.52 },
    ];
    const clipped: Pt[] = [];
    const inside = (p: Pt) => p.x * dx + p.z * dz <= limit;
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i]!;
      const end = polygon[(i + 1) % polygon.length]!;
      if (inside(start)) clipped.push(start);
      if (inside(start) !== inside(end)) {
        const denominator = (end.x - start.x) * dx + (end.z - start.z) * dz;
        if (Math.abs(denominator) > 1e-9) {
          const t = (limit - start.x * dx - start.z * dz) / denominator;
          clipped.push({ x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t });
        }
      }
    }
    ctx.beginPath();
    if (clipped.length === 0) {
      ctx.rect(-2, -2, 0, 0);
    } else {
      ctx.moveTo(clipped[0]!.x, clipped[0]!.z);
      for (let i = 1; i < clipped.length; i++) ctx.lineTo(clipped[i]!.x, clipped[i]!.z);
      ctx.closePath();
    }
    ctx.clip();
  }
}

function roadPath(ctx: CanvasRenderingContext2D, anchor: Pt, side: Side): void {
  const edge = sideCentre(side);
  // The first 0.12 units are perpendicular to the edge, preserving the seam.
  const inner = { x: edge.x * 0.76, z: edge.z * 0.76 };
  ctx.moveTo(edge.x, edge.z);
  ctx.lineTo(inner.x, inner.z);
  ctx.quadraticCurveTo(
    inner.x * 0.51 + anchor.x * 0.49,
    inner.z * 0.51 + anchor.z * 0.49,
    anchor.x, anchor.z,
  );
}

function paintRoads(ctx: CanvasRenderingContext2D, def: TileDef): void {
  const roads = def.regions.filter((region) => region.kind === 'road');
  for (const region of roads) {
    ctx.save();
    clipIndependentRegion(ctx, region, roads);
    const center = localAnchor(region.anchor);
    for (const [width, color] of [
      [0.174, '#71806a'], [0.159, '#705c42'], [0.142, '#c4a574'], [0.112, '#d2b689'],
    ] as const) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      for (const side of region.sides) {
        ctx.beginPath();
        roadPath(ctx, center, side);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(center.x, center.z, width * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    // Fine worn wheel tracks, deliberately absent from the edge strip.
    ctx.save();
    ctx.strokeStyle = 'rgba(92,66,39,0.22)';
    ctx.lineWidth = 0.005;
    for (const side of region.sides) {
      const point = sideCentre(side);
      const dx = center.x - point.x;
      const dz = center.z - point.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len * 0.035;
      const nz = dx / len * 0.035;
      ctx.beginPath();
      ctx.moveTo(point.x * 0.79 + nx, point.z * 0.79 + nz);
      ctx.quadraticCurveTo((center.x + point.x) / 2 + nx, (center.z + point.z) / 2 + nz, center.x + nx * 0.5, center.z + nz * 0.5);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }
}

function paintCities(ctx: CanvasRenderingContext2D, def: TileDef, seed: number): void {
  const cities = def.regions.filter((region) => region.kind === 'city');
  for (const [index, region] of cities.entries()) {
    const rnd = randomGenerator(seed ^ hashString(region.id) ^ Math.imul(index + 1, 189913));
    ctx.save();
    clipIndependentRegion(ctx, region, cities);
    cityPath(ctx, region);
    ctx.fillStyle = '#caaa78';
    ctx.fill();
    ctx.lineWidth = 0.016;
    ctx.strokeStyle = '#766b51';
    ctx.stroke();
    cityPath(ctx, region);
    ctx.clip();
    ctx.fillStyle = 'rgba(247,226,166,0.16)';
    ctx.fillRect(-0.5, -0.5, 1, 1);
    // Masonry and angled rooflets: city clipping preserves disconnected regions.
    for (let i = 0; i < 155; i++) {
      const x = (rnd() - 0.5) * 0.87;
      const z = (rnd() - 0.5) * 0.87;
      const w = 0.017 + rnd() * 0.034;
      const h = 0.017 + rnd() * 0.026;
      ctx.save();
      ctx.translate(x, z);
      ctx.rotate((rnd() - 0.5) * 0.62);
      ctx.fillStyle = rnd() > 0.48 ? 'rgba(110,67,47,0.57)' : 'rgba(249,216,147,0.58)';
      ctx.fillRect(-w * 0.5 + 0.004, -h * 0.5 + 0.005, w, h);
      ctx.fillStyle = rnd() > 0.43 ? '#9f5346' : '#956e52';
      ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
      ctx.strokeStyle = 'rgba(252,217,166,0.44)';
      ctx.lineWidth = 0.003;
      ctx.beginPath();
      ctx.moveTo(-w * 0.5, -h * 0.2);
      ctx.lineTo(w * 0.5, -h * 0.2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    if (region.shields > 0) {
      for (let shield = 0; shield < Math.min(region.shields, 3); shield++) {
        const hub = localAnchor(region.anchor);
        drawKiteShield(ctx, hub.x + (shield - (region.shields - 1) / 2) * 0.09, hub.z - 0.014, 0.066);
      }
    }
  }
}

function drawKiteShield(ctx: CanvasRenderingContext2D, x: number, z: number, size: number): void {
  ctx.save();
  ctx.translate(x, z);
  ctx.scale(size, size);
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(-0.55, -0.5);
    ctx.lineTo(0.55, -0.5);
    ctx.lineTo(0.49, 0.35);
    ctx.lineTo(0, 0.83);
    ctx.lineTo(-0.49, 0.35);
    ctx.closePath();
  };
  ctx.translate(0.027, 0.03);
  outline();
  ctx.fillStyle = 'rgba(50,39,27,0.45)';
  ctx.fill();
  ctx.translate(-0.027, -0.03);
  outline();
  ctx.fillStyle = '#e3b96c';
  ctx.fill();
  ctx.scale(0.8, 0.8);
  outline();
  ctx.fillStyle = '#812e30';
  ctx.fill();
  ctx.fillStyle = '#f9df9b';
  ctx.fillRect(-0.10, -0.43, 0.20, 1.0);
  ctx.fillRect(-0.43, -0.10, 0.86, 0.18);
  ctx.restore();
}

function paintMonastery(ctx: CanvasRenderingContext2D, region: Extract<TileRegion, { kind: 'monastery' }>): void {
  const pos = localAnchor(region.anchor);
  ctx.save();
  ctx.translate(pos.x, pos.z);
  ctx.rotate(-0.11);
  ctx.fillStyle = 'rgba(40,55,36,0.24)';
  ctx.beginPath();
  ctx.ellipse(0.023, 0.038, 0.22, 0.17, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#d7bd8c';
  ctx.fillRect(-0.16, -0.13, 0.32, 0.26);
  ctx.strokeStyle = '#806a4a';
  ctx.lineWidth = 0.012;
  ctx.strokeRect(-0.16, -0.13, 0.32, 0.26);
  ctx.fillStyle = '#a45042';
  ctx.beginPath();
  ctx.moveTo(-0.19, -0.13);
  ctx.lineTo(0, -0.23);
  ctx.lineTo(0.19, -0.13);
  ctx.lineTo(0.19, 0.12);
  ctx.lineTo(0, 0.025);
  ctx.lineTo(-0.19, 0.12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e9b578';
  ctx.lineWidth = 0.008;
  ctx.stroke();
  ctx.fillStyle = '#674c39';
  ctx.fillRect(-0.025, 0.08, 0.05, 0.055);
  ctx.fillStyle = '#e7c588';
  ctx.fillRect(-0.064, -0.065, 0.045, 0.042);
  ctx.fillRect(0.032, -0.065, 0.045, 0.042);
  ctx.strokeStyle = '#eed99d';
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(0, -0.29);
  ctx.lineTo(0, -0.205);
  ctx.moveTo(-0.035, -0.261);
  ctx.lineTo(0.035, -0.261);
  ctx.stroke();
  ctx.restore();
}

function paintPasture(ctx: CanvasRenderingContext2D, def: TileDef, rng: () => number): void {
  ctx.fillStyle = '#a8b681';
  ctx.fillRect(-0.5, -0.5, 1, 1);
  const wash = ctx.createRadialGradient(-0.17, -0.25, 0.03, 0.04, 0.02, 0.72);
  wash.addColorStop(0, 'rgba(235,211,152,0.29)');
  wash.addColorStop(0.65, 'rgba(70,104,62,0.02)');
  wash.addColorStop(1, 'rgba(67,79,49,0.24)');
  ctx.fillStyle = wash;
  ctx.fillRect(-0.5, -0.5, 1, 1);
  // No random brush mark touches the protected seam or rounded corners.
  for (let i = 0; i < 1500; i++) {
    const x = (rng() - 0.5) * 0.87;
    const z = (rng() - 0.5) * 0.87;
    const radius = 0.0015 + rng() * 0.007;
    ctx.fillStyle = rng() > 0.55 ? 'rgba(242,222,145,0.33)' : 'rgba(56,100,60,0.21)';
    ctx.beginPath();
    ctx.ellipse(x, z, radius, radius * (0.4 + rng()), rng(), 0, 2 * Math.PI);
    ctx.fill();
  }
  for (const region of def.regions) {
    if (region.kind !== 'field') continue;
    const point = localAnchor(region.anchor);
    const clusters = Math.max(5, Math.min(16, region.ports.length * 2 + 5));
    for (let i = 0; i < clusters; i++) {
      const theta = rng() * Math.PI * 2;
      const radius = rng() * 0.22;
      const x = Math.max(-0.43, Math.min(0.43, point.x + Math.cos(theta) * radius));
      const z = Math.max(-0.43, Math.min(0.43, point.z + Math.sin(theta) * radius));
      const size = 0.018 + rng() * 0.014;
      ctx.fillStyle = 'rgba(67,105,60,0.29)';
      ctx.beginPath();
      ctx.ellipse(x + 0.009, z + 0.011, size * 1.4, size * 0.8, 0, 0, 2 * Math.PI);
      ctx.fill();
      for (let leaf = 0; leaf < 3; leaf++) {
        const angle = leaf / 3 * Math.PI * 2;
        ctx.fillStyle = leaf % 2 === 0 ? '#6e8f58' : '#c9bb74';
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(angle) * size * 0.55, z + Math.sin(angle) * size * 0.5, size * 0.72, size * 0.57, 0, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

function paintStandardizedEdges(ctx: CanvasRenderingContext2D, def: TileDef): void {
  // Canonical edge strips: identical for all tile definitions sharing an edge.
  // Neutral squared-off corner patches resolve the otherwise impossible case
  // of two different terrains demanding two different colors at one point.
  for (let k = 0; k < 4; k++) {
    const side = SIDE_ORDER[k]!;
    const terrain = def.edges[k];
    if (!terrain) continue;
    ctx.save();
    switch (side) {
      case 'N': ctx.translate(0, -0.5); break;
      case 'E': ctx.translate(0.5, 0); ctx.rotate(Math.PI / 2); break;
      case 'S': ctx.translate(0, 0.5); ctx.rotate(Math.PI); break;
      case 'W': ctx.translate(-0.5, 0); ctx.rotate(-Math.PI / 2); break;
    }
    // Every edge is drawn from local x=-0.5..0.5, inward local y=0..BAND.
    ctx.fillStyle = terrain === 'city' ? '#caaa78' : '#a8b681';
    ctx.fillRect(-0.5, 0, 1, BAND);
    if (terrain === 'city') {
      ctx.fillStyle = 'rgba(238,205,140,0.32)';
      ctx.fillRect(-0.5, BAND * 0.7, 1, BAND * 0.24);
    }
    if (terrain === 'road') {
      ctx.fillStyle = '#71806a';
      ctx.fillRect(-0.086, 0, 0.172, BAND);
      ctx.fillStyle = '#705c42';
      ctx.fillRect(-0.0795, 0, 0.159, BAND);
      ctx.fillStyle = '#c4a574';
      ctx.fillRect(-0.071, 0, 0.142, BAND);
      ctx.fillStyle = '#d2b689';
      ctx.fillRect(-0.056, 0, 0.112, BAND);
    }
    ctx.restore();
  }
  ctx.fillStyle = '#b4ab88';
  for (const x of [-0.5, 0.5 - EDGE_CORNER]) {
    for (const z of [-0.5, 0.5 - EDGE_CORNER]) {
      ctx.fillRect(x, z, EDGE_CORNER, EDGE_CORNER);
    }
  }
}

/** Renders exactly one canonical (unrotated) tile; all rotations use its mesh group. */
export function paintTileArtwork(ctx: CanvasRenderingContext2D, tile: TileDef, size: number): void {
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.setTransform(size, 0, 0, size, size / 2, size / 2);
  const seed = hashString(JSON.stringify(tile));
  const rng = randomGenerator(seed);
  paintPasture(ctx, tile, rng);
  paintRoads(ctx, tile);
  paintCities(ctx, tile, seed);
  for (const region of tile.regions) {
    if (region.kind === 'monastery') paintMonastery(ctx, region);
  }
  paintStandardizedEdges(ctx, tile);
  // Inked interior trim remains constant across tile IDs at the exterior.
  ctx.lineWidth = 0.004;
  ctx.strokeStyle = 'rgba(74,64,43,0.35)';
  ctx.strokeRect(-0.479, -0.479, 0.958, 0.958);
  ctx.restore();
}

export function artworkCanvas(tile: TileDef, size = 512): HTMLCanvasElement {
  const key = size + ':' + JSON.stringify(tile);
  const cached = canvasCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable for procedural tile artwork');
  paintTileArtwork(ctx, tile, size);
  canvasCache.set(key, canvas);
  if (canvasCache.size > 140) canvasCache.delete(canvasCache.keys().next().value!);
  return canvas;
}

export function artworkTexture(tile: TileDef): CanvasTexture {
  const key = JSON.stringify(tile);
  const cached = textureCache.get(key);
  if (cached) return cached;
  const texture = new CanvasTexture(artworkCanvas(tile));
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  textureCache.set(key, texture);
  // 72 base tiles require substantially fewer than 140 unique definitions.
  if (textureCache.size > 140) {
    const oldest = textureCache.keys().next().value;
    if (oldest) {
      textureCache.get(oldest)?.dispose();
      textureCache.delete(oldest);
    }
  }
  return texture;
}
