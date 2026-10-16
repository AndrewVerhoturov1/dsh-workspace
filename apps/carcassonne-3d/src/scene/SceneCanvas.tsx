import { Canvas, useThree } from '@react-three/fiber';
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DoubleSide, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { ReactNode } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { PickId, PlacedTile, PlacementOption } from '../game';
import type { SceneCanvasProps } from './types';
import { BoardFallback2D } from './BoardFallback2D';
import { CameraController } from './CameraController';
import { MeepleMesh } from './MeepleMesh';
import { FollowerRegionMarker } from './RegionMarkers';
import { TableEnvironment } from './TableEnvironment';
import { TILE_TOP_Y, TileMesh } from './TileMesh';
import { anchorOnBoard, calculateExtents } from './sceneGeometry';

const legalGeometry = new PlaneGeometry(0.89, 0.89);
const legalMaterial = new MeshBasicMaterial({
  color: '#ffdb82', transparent: true, opacity: 0.19,
  side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
});

interface BoundaryProps {
  children: ReactNode;
  fallback: (message: string) => ReactNode;
  onFail: (message: string) => void;
}
interface BoundaryState { message: string | null }

/** R3F Canvas errors are caught outside its internal reconciler. */
class SceneBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { message: null };
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown): void {
    this.props.onFail(error instanceof Error ? error.message : String(error));
  }
  render(): ReactNode {
    return this.state.message ? this.props.fallback(this.state.message) : this.props.children;
  }
}

function WebGLContextGuard({ onLost }: { onLost: (message: string) => void }): null {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onLost('WebGL-контекст потерян. Включён двумерный режим.');
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [gl, onLost]);
  return null;
}

interface LegalMarkerProps {
  option: PlacementOption;
  onPick: (id: PlacementOption['id']) => void;
  onHover: (id: PickId | null) => void;
}

function LegalMarker({ option, onPick, onHover }: LegalMarkerProps): React.JSX.Element {
  return (
    <mesh
      geometry={legalGeometry}
      material={legalMaterial}
      position={[option.x, TILE_TOP_Y + 0.013, option.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      userData={{ pickId: option.id }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onPick(option.id);
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHover(option.id);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHover(null);
      }}
    />
  );
}

interface BoardSceneProps extends SceneCanvasProps {
  fitToken: number;
  onLocalHover: (id: PickId | null) => void;
  hovered: PickId | null;
  onWebGLLost: (message: string) => void;
}

function BoardScene(props: BoardSceneProps): React.JSX.Element {
  const {
    board, definitions, legalPlacements, followerTargets, selectedRotation,
    camera, onPlacementPick, onRegionPick, onLocalHover, onCameraChange,
    hovered, fitToken, onWebGLLost,
  } = props;

  const defs = useMemo(() => new Map(definitions.map((def) => [def.id, def])), [definitions]);
  const candidates = useMemo(
    () => legalPlacements.filter((option) => option.rotation === selectedRotation),
    [legalPlacements, selectedRotation],
  );
  const pendingDef = board.pendingTile ? defs.get(board.pendingTile.defId) : undefined;
  const extents = useMemo(
    () => calculateExtents([...board.tiles, ...candidates]),
    [board.tiles, candidates],
  );
  const visible = useMemo(
    () => [...board.tiles, ...candidates].map(({ x, z }) => ({ x, z })),
    [board.tiles, candidates],
  );
  const boardTiles = board.tiles.map((tile: PlacedTile) => {
    const definition = defs.get(tile.defId);
    if (!definition) return null;
    return (
      <TileMesh
        key={tile.id} tile={definition} x={tile.x} z={tile.z}
        rotation={tile.rotation}
        selected={board.phase === 'meeple' && followerTargets.some((t) => t.tileInstanceId === tile.id)}
      />
    );
  });

  const placedMeeples = board.meeples.map((meeple) => {
    const match = /^region:(-?\d+),(-?\d+):(.+)$/.exec(meeple.targetId);
    if (!match) return null;
    const tile = board.tiles.find((item) => item.x === Number(match[1]) && item.z === Number(match[2]));
    if (!tile) return null;
    const region = defs.get(tile.defId)?.regions.find((item) => item.id === match[3]);
    const player = board.players.find((item) => item.id === meeple.playerId);
    if (!region || !player) return null;
    const anchor = anchorOnBoard(tile, region.anchor);
    return (
      <MeepleMesh
        key={meeple.id} x={anchor.x} z={anchor.z}
        farmer={region.kind === 'field'} player={player}
      />
    );
  });

  const previousPlacement = /^place:(-?\d+),(-?\d+):r[0-3]$/.exec(hovered ?? '');
  const ghost = candidates.find((option) => option.id === hovered)
    ?? (previousPlacement ? candidates.find((option) =>
      option.x === Number(previousPlacement[1]) && option.z === Number(previousPlacement[2])) : undefined);
  return (
    <>
      <color attach="background" args={['#342b27']} />
      <fog attach="fog" args={['#342b27', 28, 95]} />
      <WebGLContextGuard onLost={onWebGLLost} />
      <TableEnvironment bounds={extents} />
      {boardTiles}
      {placedMeeples}
      {board.phase === 'tile' && pendingDef && candidates.map((option) => (
        <LegalMarker key={option.id} option={option} onPick={onPlacementPick} onHover={onLocalHover} />
      ))}
      {board.phase === 'tile' && pendingDef && ghost && (
        <TileMesh
          key={pendingDef.id + ':' + ghost.x + ',' + ghost.z} tile={pendingDef}
          x={ghost.x} z={ghost.z} rotation={ghost.rotation} ghost selected
          pickId={ghost.id} onPick={() => onPlacementPick(ghost.id)} onHover={onLocalHover}
        />
      )}
      {board.phase === 'meeple' && followerTargets.map((target) => (
        <FollowerRegionMarker
          key={target.id} target={target} board={board}
          onPick={onRegionPick} onHover={onLocalHover}
        />
      ))}
      <CameraController
        pose={camera} fitToken={fitToken} visibleTiles={visible}
        onPoseChange={onCameraChange}
      />
    </>
  );
}

/** Interactive 3D board; only IDs from the received legal lists are emitted. */
export function SceneCanvas(props: SceneCanvasProps): React.JSX.Element {
  const [fitToken, setFitToken] = useState(0);
  const [hovered, setHovered] = useState<PickId | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const seenError = useRef<string | null>(null);
  const currentHover = useRef<PickId | null>(null);

  const reportError = useCallback((message: string) => {
    if (seenError.current === message) return;
    seenError.current = message;
    setRenderError(message);
    props.onRenderError(message);
  }, [props.onRenderError]);

  const changeHover = useCallback((next: PickId | null) => {
    if (currentHover.current === next) return;
    currentHover.current = next;
    setHovered(next);
    props.onHoverChange(next);
  }, [props.onHoverChange]);

  const fallback = (message: string) => (
    <BoardFallback2D
      board={props.board} definitions={props.definitions}
      legalPlacements={props.legalPlacements} followerTargets={props.followerTargets}
      selectedRotation={props.selectedRotation} onPlacementPick={props.onPlacementPick}
      onRegionPick={props.onRegionPick} onHoverChange={props.onHoverChange} message={message}
    />
  );

  return (
    <div
      data-testid="scene-container"
      style={{
        position: 'relative', width: '100%', height: '100%', minHeight: 360,
        background: '#362b24', border: '4px ridge #99734f', borderRadius: 8,
        overflow: 'hidden', boxShadow: 'inset 0 0 35px #1b1511, 0 9px 23px #21191377',
      }}
    >
      {renderError ? fallback(renderError) : (
        <SceneBoundary fallback={fallback} onFail={reportError}>
          <Canvas
            shadows="soft"
            dpr={[1, 1.75]}
            frameloop="demand"
            camera={{ position: [6, 8, 10], fov: 43, near: 0.055, far: 180 }}
            gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
            // Canvas.fallback is mounted HTML canvas content, not a WebGL failure signal.
            // Actual renderer creation errors reach SceneBoundary through R3F.
            onPointerMissed={() => changeHover(null)}
            style={{ width: '100%', height: '100%' }}
          >
            <BoardScene
              {...props}
              fitToken={fitToken}
              hovered={hovered}
              onLocalHover={changeHover}
              onWebGLLost={reportError}
            />
          </Canvas>
        </SceneBoundary>
      )}
      {!renderError && (
        <button
          type="button"
          aria-label="Показать всё игровое поле"
          data-testid="scene-fit-board"
          onClick={() => setFitToken((token) => token + 1)}
          style={{
            position: 'absolute', top: 12, right: 12, zIndex: 2,
            background: 'linear-gradient(#eedbb1,#bb9865)',
            color: '#3d2d23', padding: '8px 12px', border: '1px solid #6b4c32',
            borderRadius: 5, boxShadow: '0 3px 8px #1e130f88', font: 'bold 13px Georgia, serif',
            cursor: 'pointer',
          }}
        >Поле целиком</button>
      )}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', left: 12, bottom: 12, zIndex: 1,
          background: '#2f251dcd', color: '#e9d3ad', pointerEvents: 'none',
          borderRadius: 4, padding: '5px 8px', font: '11px Georgia, serif',
        }}
      >Вращение · перемещение · масштаб</div>
    </div>
  );
}

