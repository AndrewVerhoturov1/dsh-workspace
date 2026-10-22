import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry,
  Float32BufferAttribute, LatheGeometry, MathUtils, PlaneGeometry, SphereGeometry,
  SRGBColorSpace, Vector2,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HeraldicSymbol, Player } from '../game';
import { TILE_TOP_Y } from './TileMesh';

const WOOD = '#b88859';
const bodyProfile = [
  [0.065, 0.013], [0.082, 0.022], [0.083, 0.044], [0.061, 0.073],
  [0.058, 0.11], [0.085, 0.155], [0.075, 0.183], [0.046, 0.194],
  [0.041, 0.213], [0.047, 0.225],
].map(([radius, height]) => new Vector2(radius!, height!));
const bodyGeometry = new LatheGeometry(bodyProfile, 12);
const emblemCache = new Map<string, CanvasTexture>();
const pawnGeometryCache = new Map<string, BufferGeometry>();

function tinted(geometry: BufferGeometry, color: string): BufferGeometry {
  const rgb = new Color(color);
  const attr = geometry.getAttribute('position');
  const shades = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    shades[3 * i] = rgb.r;
    shades[3 * i + 1] = rgb.g;
    shades[3 * i + 2] = rgb.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(shades, 3));
  return geometry;
}

function pawnGeometry(playerColor: string): BufferGeometry {
  const cached = pawnGeometryCache.get(playerColor);
  if (cached) return cached;
  const parts = [
    tinted(bodyGeometry.clone(), WOOD),
    tinted(new CylinderGeometry(0.064, 0.057, 0.085, 12).translate(0, 0.123, 0), playerColor),
    tinted(new SphereGeometry(0.058, 12, 10).translate(0, 0.257, 0), '#d6aa75'),
    tinted(new CylinderGeometry(0.054, 0.070, 0.028, 10).translate(0, 0.305, 0), playerColor),
    tinted(new BoxGeometry(0.102, 0.093, 0.017).translate(0, 0.174, 0.065), '#684d34'),
  ];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Failed to merge carved pawn geometry');
  pawnGeometryCache.set(playerColor, merged);
  return merged;
}

const crestGeometry = (() => {
  const panel = new PlaneGeometry(0.086, 0.086).translate(0, 0.175, 0.076);
  const top = new CircleGeometry(0.046, 24).rotateX(-Math.PI / 2).translate(0, 0.325, 0);
  const merged = mergeGeometries([panel, top], false);
  panel.dispose();
  top.dispose();
  if (!merged) throw new Error('Failed to merge heraldic inlays');
  return merged;
})();

function paintSymbol(ctx: CanvasRenderingContext2D, symbol: HeraldicSymbol): void {
  ctx.save();
  ctx.translate(48, 48);
  ctx.fillStyle = '#f6e3ad';
  ctx.strokeStyle = '#f6e3ad';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (symbol) {
    case 'sun':
      for (let k = 0; k < 12; k++) {
        const a = k * Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 18, Math.sin(a) * 18);
        ctx.lineTo(Math.cos(a) * 29, Math.sin(a) * 29);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'tower':
      ctx.fillRect(-18, -16, 36, 43);
      for (let k = -1; k <= 1; k++) ctx.fillRect(k * 16 - 6, -28, 12, 15);
      ctx.fillStyle = '#77523a';
      ctx.fillRect(-6, 5, 12, 22);
      ctx.fillRect(-11, -12, 7, 8);
      ctx.fillRect(5, -12, 7, 8);
      break;
    case 'oak':
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(0, 27);
      ctx.lineTo(0, -6);
      ctx.moveTo(0, 7);
      ctx.lineTo(-18, -12);
      ctx.moveTo(0, 7);
      ctx.lineTo(18, -11);
      ctx.stroke();
      for (const [x, y, r] of [[-15, -16, 13], [0, -25, 16], [16, -14, 14], [0, -8, 14]] as const) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'eagle':
      ctx.beginPath();
      ctx.moveTo(0, -22);
      ctx.lineTo(-10, -10);
      ctx.lineTo(-35, -25);
      ctx.lineTo(-27, 2);
      ctx.lineTo(-12, 11);
      ctx.lineTo(-18, 26);
      ctx.lineTo(0, 16);
      ctx.lineTo(18, 26);
      ctx.lineTo(12, 11);
      ctx.lineTo(27, 2);
      ctx.lineTo(35, -25);
      ctx.lineTo(10, -10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#6d4639';
      ctx.beginPath();
      ctx.arc(-4, -13, 2, 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'lion':
      ctx.beginPath();
      ctx.arc(-4, -10, 19, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-17, 0, 29, 16);
      ctx.fillRect(-18, 10, 7, 19);
      ctx.fillRect(7, 10, 7, 19);
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(12, 3);
      ctx.bezierCurveTo(32, 10, 30, -17, 22, -19);
      ctx.stroke();
      ctx.fillStyle = '#6d4639';
      ctx.beginPath();
      ctx.arc(-11, -14, 2, 0, Math.PI * 2);
      ctx.arc(0, -14, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}

function emblemTexture(player: Player): CanvasTexture {
  const key = player.color + ':' + player.heraldicSymbol;
  const cached = emblemCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to render heraldry');
  ctx.fillStyle = '#47372d';
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.arc(48, 48, 43, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#eacb84';
  ctx.lineWidth = 6;
  ctx.stroke();
  paintSymbol(ctx, player.heraldicSymbol);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  emblemCache.set(key, texture);
  return texture;
}

interface MeepleMeshProps {
  player: Player;
  x: number;
  z: number;
  farmer: boolean;
}

/** Stylised carved wooden gaming token; a farmer physically rests on its side. */
export function MeepleMesh({ player, x, z, farmer }: MeepleMeshProps): React.JSX.Element {
  const group = useRef<import('three').Group>(null);
  const settling = useRef(0.27);
  const emblem = useMemo(() => emblemTexture(player), [player]);
  const carvedPawn = useMemo(() => pawnGeometry(player.color), [player.color]);

  useFrame((state, delta) => {
    settling.current = MathUtils.damp(settling.current, 0, 12, delta);
    if (group.current) group.current.position.y = TILE_TOP_Y + (farmer ? 0.094 : 0.008) + settling.current;
    if (settling.current > 0.001) state.invalidate();
  });

  return (
    <group ref={group} position={[x, TILE_TOP_Y + (farmer ? 0.094 : 0.008), z + (farmer ? 0.119 : 0)]}>
      <group rotation={[farmer ? -Math.PI / 2 : 0, 0, 0]}>
        <mesh geometry={carvedPawn} castShadow receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.83} metalness={0} />
        </mesh>
        <mesh geometry={crestGeometry} castShadow>
          <meshStandardMaterial map={emblem} roughness={0.87} transparent alphaTest={0.05} side={2} />
        </mesh>
      </group>
    </group>
  );
}
