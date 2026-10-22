import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, MathUtils, Shape } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { PickId, Rotation, TileDef } from '../game';
import { artworkTexture } from './tileArtwork';
import { rotationRadians } from './sceneGeometry';

export const TILE_TOP_Y = 0.113;
const BASE_Y = 0.028;
const IMAGE_SIZE = 0.976;

function makeCardboardGeometry(): ExtrudeGeometry {
  const shape = new Shape();
  shape.moveTo(-0.472, 0.472);
  shape.lineTo(0.472, 0.472);
  shape.lineTo(0.472, -0.472);
  shape.lineTo(-0.472, -0.472);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    steps: 1,
    depth: 0.065,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.018,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const face = new Color('#d6bd91');
  const edge = new Color('#936f4b');
  const tone = new Color();
  const colors: number[] = [];
  for (let i = 0; i < normals.count; i++) {
    tone.copy(edge).lerp(face, Math.max(0, normals.getY(i)));
    colors.push(tone.r, tone.g, tone.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.clearGroups(); // one cardboard draw call, including colored bevels
  return geometry;
}

const cardboardGeometry = makeCardboardGeometry();

interface TileMeshProps {
  tile: TileDef;
  x?: number;
  z?: number;
  rotation: Rotation;
  ghost?: boolean;
  selected?: boolean;
  pickId?: PickId;
  onPick?: (id: PickId) => void;
  onHover?: (id: PickId | null) => void;
  children?: React.ReactNode;
}

/** The same three-dimensional cardboard tile is used by board and Tile Lab. */
export function TileMesh({
  tile, x = 0, z = 0, rotation, ghost = false, selected = false,
  pickId, onPick, onHover, children,
}: TileMeshProps): React.JSX.Element {
  const group = useRef<import('three').Group>(null);
  const artwork = useMemo(() => artworkTexture(tile), [tile]);
  const firstHeight = useRef(ghost ? 0.07 : 0.24);
  const targetRotation = rotationRadians(rotation);
  // Ghost pixels never steal ray hits from the legal placement below them.
  const ghostRaycast = ghost ? { raycast: () => {} } : {};

  useFrame((state, delta) => {
    const node = group.current;
    if (!node) return;
    firstHeight.current = MathUtils.damp(firstHeight.current, ghost ? 0.045 : 0, 10, delta);
    node.position.y = firstHeight.current;
    // Shortest circular interpolation avoids a 270° spin when r3 wraps to r0.
    const angleError = Math.atan2(Math.sin(targetRotation - node.rotation.y), Math.cos(targetRotation - node.rotation.y));
    node.rotation.y += angleError * (1 - Math.exp(-Math.min(delta, 0.08) * 12));
    if (Math.abs(firstHeight.current - (ghost ? 0.045 : 0)) > 0.0003
      || Math.abs(angleError) > 0.0003) state.invalidate();
  });

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!pickId || !onPick) return;
    event.stopPropagation();
    onPick(pickId);
  };
  const handleEnter = (event: ThreeEvent<PointerEvent>) => {
    if (!pickId || !onHover) return;
    event.stopPropagation();
    onHover(pickId);
  };
  const handleLeave = (event: ThreeEvent<PointerEvent>) => {
    if (!pickId || !onHover) return;
    event.stopPropagation();
    onHover(null);
  };

  return (
    <group
      ref={group}
      position={[x, 0, z]}
      rotation={[0, targetRotation, 0]}
      userData={pickId ? { pickId } : {}}
      onClick={handleClick}
      onPointerOver={handleEnter}
      onPointerOut={handleLeave}
    >
      <mesh geometry={cardboardGeometry} {...ghostRaycast} position={[0, BASE_Y, 0]} castShadow={!ghost} receiveShadow>
        <meshStandardMaterial
          vertexColors color={selected ? '#fff3dd' : '#ffffff'}
          roughness={0.94} metalness={0} transparent={ghost} opacity={ghost ? 0.48 : 1}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, TILE_TOP_Y, 0]}
        receiveShadow {...ghostRaycast}
        userData={pickId ? { pickId } : {}}
      >
        <planeGeometry args={[IMAGE_SIZE, IMAGE_SIZE]} />
        <meshStandardMaterial
          map={artwork} roughness={0.92} metalness={0} color="#ffffff"
          transparent={ghost} opacity={ghost ? 0.75 : 1}
          side={DoubleSide} depthWrite={!ghost}
        />
      </mesh>
      {selected && (
        <mesh {...ghostRaycast} rotation={[-Math.PI / 2, 0, 0]} position={[0, TILE_TOP_Y + 0.007, 0]}>
          <ringGeometry args={[0.665, 0.683, 4, 1, Math.PI / 4]} />
          <meshBasicMaterial color="#fff0a0" transparent opacity={0.83} side={DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {children}
    </group>
  );
}

/** Deliberately exported only for geometry diagnostics and advanced previews. */
export function tileTopHeight(): number {
  return TILE_TOP_Y;
}

