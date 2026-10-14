import { SceneLabel } from './SceneLabel';
import type { ThreeEvent } from '@react-three/fiber';
import type { BoardView, FollowerTarget, PickId, TileDef } from '../game';
import { anchorOnBoard } from './sceneGeometry';
import { fieldPortPosition } from './tileArtwork';
import { TILE_TOP_Y } from './TileMesh';

const REGION_COLORS = {
  field: '#5b8d57',
  road: '#d6a362',
  city: '#a8493e',
  monastery: '#e9c17f',
} as const;

interface PlacementMarkerProps {
  target: FollowerTarget;
  board: BoardView;
  onPick: (id: FollowerTarget['id']) => void;
  onHover: (id: PickId | null) => void;
}

export function FollowerRegionMarker({
  target, board, onPick, onHover,
}: PlacementMarkerProps): React.JSX.Element | null {
  const tile = board.tiles.find((item) => item.id === target.tileInstanceId);
  if (!tile) return null;
  const anchor = anchorOnBoard(tile, target.anchor);
  const color = REGION_COLORS[target.kind];
  const handlePick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onPick(target.id);
  };
  const handleEnter = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(target.id);
  };
  const handleLeave = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(null);
  };

  return (
    <group
      position={[anchor.x, TILE_TOP_Y + 0.045, anchor.z]}
      userData={{ pickId: target.id, regionId: target.regionId }}
      onClick={handlePick}
      onPointerOver={handleEnter}
      onPointerOut={handleLeave}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.084, 0.114, 32]} />
        <meshBasicMaterial color="#fff3ce" transparent opacity={0.92} depthTest={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <circleGeometry args={[0.083, 32]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.22} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.027, 0]}>
        <sphereGeometry args={[0.031, 12, 10]} />
        <meshStandardMaterial color="#fff5db" roughness={0.8} />
      </mesh>
      <SceneLabel text={target.regionId} position={[0, 0.16, 0]} />
    </group>
  );
}

interface TileDiagnosticProps {
  tile: TileDef;
  showAnchors: boolean;
  showPorts: boolean;
}

/** Logical overlays derived solely from TileDef, rotated together with TileMesh. */
export function TileDiagnosticMarkers({
  tile, showAnchors, showPorts,
}: TileDiagnosticProps): React.JSX.Element {
  return (
    <group>
      {showAnchors && tile.regions.map((region) => (
        <group key={region.id} position={[region.anchor.u, TILE_TOP_Y + 0.018, region.anchor.v]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.042, 24]} />
            <meshBasicMaterial color={REGION_COLORS[region.kind]} transparent opacity={0.96} depthTest={false} />
          </mesh>
          <SceneLabel text={region.kind + ": " + region.id} position={[0, 0.11, 0]} height={0.10} />
        </group>
      ))}
      {showPorts && tile.regions.flatMap((region) => region.kind === 'field'
        ? region.ports.map((port) => {
          const point = fieldPortPosition(port);
          return (
            <group key={region.id + '/' + port} position={[point.x, TILE_TOP_Y + 0.025, point.z]}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.026, 16]} />
                <meshBasicMaterial color="#244b36" />
              </mesh>
              <SceneLabel text={port} position={[0, 0.075, 0]} height={0.085} />
            </group>
          );
        })
        : [])}
    </group>
  );
}
