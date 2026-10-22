import { useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import type { FollowerTarget, PickId, PlacementOption, TileDef } from '../game';
import type { SceneCanvasProps } from './types';
import { anchorOnBoard, calculateExtents } from './sceneGeometry';
import { artworkCanvas } from './tileArtwork';

type FallbackProps = Pick<
  SceneCanvasProps,
  'board' | 'definitions' | 'legalPlacements' | 'followerTargets' |
  'selectedRotation' | 'onPlacementPick' | 'onRegionPick' | 'onHoverChange'
> & { message?: string };

interface Transform {
  px: (x: number, z: number) => { x: number; y: number };
  fromPx: (x: number, y: number) => { x: number; z: number };
  scale: number;
}

function viewport(width: number, height: number, positions: readonly { x: number; z: number }[]): Transform {
  const bounds = calculateExtents(positions);
  const halfX = (bounds.minX + bounds.maxX) / 2;
  const halfZ = (bounds.minZ + bounds.maxZ) / 2;
  const scale = Math.max(2, Math.min(
    (width - 36) / Math.max(2, bounds.maxX - bounds.minX + 1),
    (height - 70) / Math.max(2, bounds.maxZ - bounds.minZ + 1),
  ));
  return {
    scale,
    px: (x, z) => ({ x: width / 2 + (x - halfX) * scale, y: height / 2 + (z - halfZ) * scale }),
    fromPx: (x, y) => ({ x: halfX + (x - width / 2) / scale, z: halfZ + (y - height / 2) / scale }),
  };
}

/** Genuine top-down 2D board: no CSS simulation or false claim of 3D. */
export function BoardFallback2D({
  board, definitions, legalPlacements, followerTargets, selectedRotation,
  onPlacementPick, onRegionPick, onHoverChange, message,
}: FallbackProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Transform | null>(null);
  const hoverRef = useRef<PickId | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const defs = new Map(definitions.map((def) => [def.id, def]));
  const legal = legalPlacements.filter((option) => option.rotation === selectedRotation);
  const pending = board.pendingTile ? defs.get(board.pendingTile.defId) : undefined;
  const occupied = [...board.tiles, ...legal];

  useEffect(() => {
    const node = wrapRef.current;
    const canvas = canvasRef.current;
    if (!node || !canvas) return;
    const draw = () => {
      const box = node.getBoundingClientRect();
      const width = Math.max(140, box.width);
      const height = Math.max(140, box.height);
      const ratio = Math.min(1.75, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const transform = viewport(width, height, occupied);
      viewportRef.current = transform;
      const scale = transform.scale;
      ctx.fillStyle = '#79563e';
      ctx.fillRect(0, 0, width, height);
      ctx.lineWidth = 3;
      for (let i = 0; i < height; i += 32) {
        ctx.strokeStyle = i % 64 === 0 ? '#62432f' : '#876044';
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(width, i);
        ctx.stroke();
      }
      const paintTile = (def: TileDef, x: number, z: number, rotation: number, alpha = 1) => {
        const point = transform.px(x, z);
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(rotation * Math.PI / 2);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#d7b88d';
        ctx.fillRect(-scale / 2, -scale / 2, scale, scale);
        ctx.drawImage(artworkCanvas(def), -scale * 0.485, -scale * 0.485, scale * 0.97, scale * 0.97);
        ctx.strokeStyle = '#674d35';
        ctx.lineWidth = Math.max(1, scale * 0.012);
        ctx.strokeRect(-scale / 2, -scale / 2, scale, scale);
        ctx.restore();
      };
      for (const tile of board.tiles) {
        const def = defs.get(tile.defId);
        if (def) paintTile(def, tile.x, tile.z, tile.rotation);
      }
      for (const option of legal) {
        const point = transform.px(option.x, option.z);
        ctx.strokeStyle = '#f1d894';
        ctx.lineWidth = 2;
        ctx.setLineDash([scale * 0.09, scale * 0.045]);
        ctx.strokeRect(point.x - scale * 0.45, point.y - scale * 0.45, scale * 0.9, scale * 0.9);
        ctx.setLineDash([]);
      }
      if (hoverRef.current && pending) {
        const hover = legal.find((choice) => choice.id === hoverRef.current);
        if (hover) paintTile(pending, hover.x, hover.z, hover.rotation, 0.72);
      }
      for (const meeple of board.meeples) {
        const parts = /^region:(-?\d+),(-?\d+):(.+)$/.exec(meeple.targetId);
        if (!parts) continue;
        const tile = board.tiles.find((candidate) => candidate.x === Number(parts[1]) && candidate.z === Number(parts[2]));
        if (!tile) continue;
        const def = defs.get(tile.defId);
        const region = def?.regions.find((candidate) => candidate.id === parts[3]);
        const player = board.players.find((candidate) => candidate.id === meeple.playerId);
        if (!region || !player) continue;
        const world = anchorOnBoard(tile, region.anchor);
        const p = transform.px(world.x, world.z);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.fillStyle = player.color;
        ctx.strokeStyle = '#2c231e';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        if (region.kind === 'field') {
          ctx.ellipse(0, 0, scale * 0.115, scale * 0.07, -0.4, 0, Math.PI * 2);
        } else {
          ctx.arc(0, 0, Math.max(5, scale * 0.08), 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff1cc';
        ctx.font = 'bold ' + Math.max(9, scale * 0.125) + 'px Georgia, serif';
        ctx.fillText(player.heraldicSymbol.slice(0, 1).toUpperCase(), 0, 1);
        ctx.restore();
      }
      for (const target of followerTargets) {
        const tile = board.tiles.find((placed) => placed.id === target.tileInstanceId);
        if (!tile) continue;
        const point = anchorOnBoard(tile, target.anchor);
        const screen = transform.px(point.x, point.z);
        ctx.fillStyle = '#b6cb95';
        ctx.strokeStyle = '#f7eac1';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, Math.max(6, scale * 0.125), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#293928';
        ctx.font = 'bold ' + Math.max(10, scale * 0.1) + 'px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(target.regionId, screen.x, screen.y - Math.max(11, scale * 0.16));
      }
    };
    draw();
    canvas.addEventListener('scene-paint', draw);
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    return () => {
      observer.disconnect();
      canvas.removeEventListener('scene-paint', draw);
    };
  }, [board, definitions, selectedRotation, legalPlacements, followerTargets]);

  const fromEvent = (event: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    pointerRef.current = { x, y };
    return viewportRef.current?.fromPx(x, y);
  };

  const lookup = (x: number, z: number): { option?: PlacementOption; target?: FollowerTarget } => {
    const transform = viewportRef.current;
    if (!transform) return {};
    for (const target of followerTargets) {
      const tile = board.tiles.find((placed) => placed.id === target.tileInstanceId);
      if (!tile) continue;
      const anchor = anchorOnBoard(tile, target.anchor);
      if (Math.hypot(anchor.x - x, anchor.z - z) < 0.18) return { target };
    }
    const option = legal.find((item) => item.x === Math.round(x) && item.z === Math.round(z)
      && Math.abs(item.x - x) < 0.48 && Math.abs(item.z - z) < 0.48);
    return option ? { option } : {};
  };

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const world = fromEvent(event);
    if (!world) return;
    const { target, option } = lookup(world.x, world.z);
    const id = target?.id ?? option?.id ?? null;
    if (hoverRef.current === id) return;
    hoverRef.current = id;
    onHoverChange(id);
    // Repaint on hover without a change in the legal IDs.
    const canvas = canvasRef.current;
    if (canvas) canvas.dispatchEvent(new Event('scene-paint'));
  };

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const world = fromEvent(event);
    if (!world) return;
    const { target, option } = lookup(world.x, world.z);
    if (target && followerTargets.some((candidate) => candidate.id === target.id)) {
      onRegionPick(target.id);
    } else if (option && legalPlacements.some((candidate) => candidate.id === option.id)) {
      onPlacementPick(option.id);
    }
  };

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', minHeight: 240, position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        aria-label="Двумерное игровое поле"
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
        onPointerMove={handlePointer}
        onPointerLeave={() => {
          hoverRef.current = null;
          onHoverChange(null);
          canvasRef.current?.dispatchEvent(new Event('scene-paint'));
        }}
        onClick={handleClick}
      />
      <div role="status" style={{
        position: 'absolute', top: 10, left: 12, pointerEvents: 'none',
        color: '#fff4d9', font: '13px Georgia, serif',
        background: '#2e241ddd', border: '1px solid #b9996d',
        padding: '6px 10px', borderRadius: 5, maxWidth: '80%',
      }}>{message ?? 'WebGL недоступен. Точный двумерный вид сверху.'}</div>
    </div>
  );
}
