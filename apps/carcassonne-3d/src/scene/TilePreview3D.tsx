import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Component, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Rotation, TileDef } from '../game';
import type { TilePreview3DProps } from './types';
import { TileMesh } from './TileMesh';
import { TileDiagnosticMarkers } from './RegionMarkers';
import { TableEnvironment } from './TableEnvironment';
import { artworkCanvas, fieldPortPosition } from './tileArtwork';

let activePreview: symbol | null = null;
const previewListeners = new Set<() => void>();
function announcePreviewAvailability(): void {
  // Release ownership after the current React cleanup, never mount another Canvas inside it.
  queueMicrotask(() => {
    for (const callback of previewListeners) callback();
  });
}

/** One active TileLab WebGL preview; remaining mounted previews are genuine 2D. */
function usePreviewLease(visible: boolean): boolean {
  const identity = useRef(Symbol('tile-preview'));
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    const token = identity.current;
    const update = () => {
      if (!visible) {
        if (activePreview === token) {
          activePreview = null;
          setGranted(false);
          announcePreviewAvailability();
        } else setGranted(false);
        return;
      }
      if (activePreview === null) activePreview = token;
      setGranted(activePreview === token);
    };
    previewListeners.add(update);
    update();
    return () => {
      previewListeners.delete(update);
      if (activePreview === token) {
        activePreview = null;
        announcePreviewAvailability();
      }
    };
  }, [visible]);
  return granted;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number, z: number, value: string, fill: string,
  scale: number,
): void {
  const textSize = Math.max(10, scale * 0.033);
  ctx.font = 'bold ' + textSize + 'px monospace';
  const width = Math.min(scale * 0.5, ctx.measureText(value).width + 8);
  const height = textSize + 6;
  ctx.fillStyle = '#28251de5';
  ctx.fillRect(x - width / 2, z - height / 2, width, height);
  ctx.strokeStyle = fill;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - width / 2, z - height / 2, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff0d0';
  ctx.fillText(value, x, z, width - 6);
}

interface ArtworkPreviewProps extends TilePreview3DProps {
  className?: string;
}

/** Canvas2D preview uses the same cached tile artwork as the WebGL plane. */
export function TileArtworkPreview2D({
  tile, rotation, showAnchors = false, showPorts = false, className,
}: ArtworkPreviewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const draw = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.max(150, rect.width);
      const height = Math.max(150, rect.height);
      const ratio = Math.min(1.75, window.devicePixelRatio || 1);
      node.width = Math.round(width * ratio);
      node.height = Math.round(height * ratio);
      const ctx = node.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const size = Math.min(width, height) * 0.79;
      ctx.fillStyle = '#65452f';
      ctx.fillRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(width / 2, height / 2, size * 0.14, width / 2, height / 2, size * 0.75);
      glow.addColorStop(0, 'rgba(244,210,149,0.21)');
      glow.addColorStop(1, 'rgba(28,19,15,0.48)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(rotation * Math.PI / 2);
      ctx.shadowColor = '#21160db0';
      ctx.shadowOffsetY = 9;
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#c7a982';
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.shadowColor = 'transparent';
      ctx.drawImage(artworkCanvas(tile), -size * 0.486, -size * 0.486, size * 0.972, size * 0.972);
      ctx.strokeStyle = '#503e30';
      ctx.lineWidth = 2;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      if (showAnchors) {
        for (const region of tile.regions) {
          const x = region.anchor.u * size;
          const z = region.anchor.v * size;
          ctx.fillStyle = region.kind === 'city' ? '#a33f38'
            : region.kind === 'road' ? '#d7a566'
              : region.kind === 'field' ? '#548b5a' : '#ead08d';
          ctx.beginPath();
          ctx.arc(x, z, Math.max(5, size * 0.021), 0, Math.PI * 2);
          ctx.fill();
          drawLabel(ctx, x, z - size * 0.065, region.id, '#ddc18e', size);
        }
      }
      if (showPorts) {
        for (const region of tile.regions) {
          if (region.kind !== 'field') continue;
          for (const port of region.ports) {
            const p = fieldPortPosition(port);
            ctx.fillStyle = '#28623c';
            ctx.beginPath();
            ctx.arc(p.x * size, p.z * size, Math.max(3, size * 0.015), 0, Math.PI * 2);
            ctx.fill();
            drawLabel(ctx, p.x * size, p.z * size, port, '#2d7847', size * 0.72);
          }
        }
      }
      ctx.restore();
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    return () => observer.disconnect();
  }, [tile, rotation, showAnchors, showPorts]);

  return (
    <canvas
      ref={canvasRef} className={className}
      aria-label={'Двумерный просмотр плитки ' + tile.id + ', поворот ' + rotation}
      style={{ display: 'block', width: '100%', height: '100%', minHeight: 210 }}
    />
  );
}

interface PreviewBoundaryProps { children: ReactNode; fallback: ReactNode }
class PreviewBoundary extends Component<PreviewBoundaryProps, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true };
  }
  render(): ReactNode {
    return this.state.broken ? this.props.fallback : this.props.children;
  }
}

/** Actual 3D Tile Lab preview, sharing slab geometry, masks and materials with SceneCanvas. */
export function TilePreview3D({
  tile, rotation, showAnchors = false, showPorts = false,
}: TilePreview3DProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: '80px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const granted = usePreviewLease(visible);
  const fallback = <TileArtworkPreview2D tile={tile} rotation={rotation} showAnchors={showAnchors} showPorts={showPorts} />;
  return (
    <div
      ref={wrapperRef} data-testid="tile-preview"
      style={{
        position: 'relative', width: '100%', height: '100%', minHeight: 230,
        background: '#65452f', overflow: 'hidden', borderRadius: 7,
        border: '2px ridge #b18b5d',
      }}
    >
      {granted ? (
        <PreviewBoundary fallback={fallback}>
          <Canvas
            shadows="soft"
            frameloop="demand"
            dpr={[1, 1.75]}
            camera={{ position: [1.65, 2.12, 2.45], fov: 37, near: 0.06, far: 60 }}
            gl={{ antialias: true, alpha: false, powerPreference: 'default' }}
            // PreviewBoundary handles actual renderer errors, not HTML canvas fallback content.
            style={{ width: '100%', height: '100%' }}
          >
            <color attach="background" args={['#4e3a2c']} />
            <TableEnvironment bounds={{ minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 }} />
            <TileMesh tile={tile} rotation={rotation}>
              <TileDiagnosticMarkers tile={tile} showAnchors={showAnchors} showPorts={showPorts} />
            </TileMesh>
            <OrbitControls
              makeDefault
              target={[0, 0, 0]}
              enablePan={false}
              enableZoom enableRotate enableDamping dampingFactor={0.085}
              minDistance={1.3} maxDistance={5.3}
              minPolarAngle={0.14} maxPolarAngle={Math.PI / 2.6}
            />
          </Canvas>
        </PreviewBoundary>
      ) : fallback}
    </div>
  );
}

/** Diagnostic adjacent tiles using the same artwork; no extra WebGL context. */
export function TilePairPreview2D({
  left, right, leftRotation = 0, rightRotation = 0,
}: {
  left: TileDef;
  right: TileDef;
  leftRotation?: Rotation;
  rightRotation?: Rotation;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const draw = () => {
      const rect = node.getBoundingClientRect();
      const w = Math.max(240, rect.width);
      const h = Math.max(120, rect.height);
      const ratio = Math.min(1.75, window.devicePixelRatio || 1);
      node.width = Math.round(w * ratio);
      node.height = Math.round(h * ratio);
      const ctx = node.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#59402f';
      ctx.fillRect(0, 0, w, h);
      const side = Math.min(h * 0.83, w * 0.43);
      for (const [i, def, r] of [[0, left, leftRotation], [1, right, rightRotation]] as const) {
        ctx.save();
        ctx.translate(w / 2 + (i === 0 ? -side / 2 : side / 2), h / 2);
        ctx.rotate(r * Math.PI / 2);
        ctx.drawImage(artworkCanvas(def), -side / 2, -side / 2, side, side);
        ctx.restore();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    return () => observer.disconnect();
  }, [left, right, leftRotation, rightRotation]);
  return <canvas ref={canvasRef} aria-label="Две соседние плитки — просмотр шва" style={{ width: '100%', height: '100%', minHeight: 165, display: 'block' }} />;
}
