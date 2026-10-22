import { useEffect, useMemo } from 'react';
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';
import type { BoardExtents } from './sceneGeometry';

let oakTexture: CanvasTexture | undefined;

function oakGrainTexture(): CanvasTexture {
  if (oakTexture) return oakTexture;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas required to draw oak tabletop');
  ctx.fillStyle = '#775036';
  ctx.fillRect(0, 0, size, size);
  // Grain oscillates across long planks with fixed deterministic perturbations.
  for (let i = 0; i < size; i++) {
    const grain = Math.sin(i * 0.14) * 9 + Math.sin(i * 0.87) * 5 + Math.sin(i * 0.036) * 15;
    const brightness = Math.round(85 + grain);
    ctx.fillStyle = 'rgba(' + (brightness + 36) + ',' + (brightness * 0.65 + 26) + ',' + (brightness * 0.42 + 12) + ',0.4)';
    ctx.fillRect(0, i, size, 1);
  }
  let seed = 59123915;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < 280; i++) {
    const y = rnd() * size;
    const x = rnd() * size;
    const span = 40 + rnd() * 330;
    const drift = rnd() * 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + span * 0.33, y - drift, x + span * 0.7, y + drift, x + span, y + drift * 0.15);
    ctx.lineWidth = 0.5 + rnd() * 1.4;
    ctx.strokeStyle = rnd() > 0.55 ? 'rgba(23,15,12,0.19)' : 'rgba(245,174,104,0.14)';
    ctx.stroke();
  }
  for (let y = 0; y <= 512; y += 128) {
    ctx.fillStyle = 'rgba(31,21,18,0.42)';
    ctx.fillRect(0, y, size, 3);
    ctx.fillStyle = 'rgba(225,166,101,0.18)';
    ctx.fillRect(0, y + 4, size, 2);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  oakTexture = texture;
  return texture;
}

interface TableEnvironmentProps {
  bounds: BoardExtents;
}

export function TableEnvironment({ bounds }: TableEnvironmentProps): React.JSX.Element {
  const width = Math.max(6, bounds.maxX - bounds.minX + 3.5);
  const depth = Math.max(6, bounds.maxZ - bounds.minZ + 3.5);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const grain = useMemo(() => {
    const texture = oakGrainTexture().clone();
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(width / 3.2, depth / 3.2);
    texture.needsUpdate = true;
    return texture;
  }, [width, depth]);
  useEffect(() => () => grain.dispose(), [grain]);
  const shadowFrustum = Math.max(width, depth) * 0.73 + 3;

  return (
    <group>
      <hemisphereLight args={['#f6deb7', '#4f4237', 1.1]} />
      <ambientLight intensity={0.31} color="#bca991" />
      <directionalLight
        position={[centerX - shadowFrustum * 0.6, 9 + shadowFrustum * 0.18, centerZ + shadowFrustum * 0.42]}
        intensity={2.6} color="#ffe1b7"
        castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-bias={-0.00014} shadow-normalBias={0.025} shadow-radius={3.5}
        shadow-camera-left={-shadowFrustum} shadow-camera-right={shadowFrustum}
        shadow-camera-top={shadowFrustum} shadow-camera-bottom={-shadowFrustum}
        shadow-camera-near={0.5} shadow-camera-far={45}
      />
      <mesh position={[centerX, -0.185, centerZ]} castShadow receiveShadow>
        <boxGeometry args={[width + 0.12, 0.31, depth + 0.12]} />
        <meshStandardMaterial color="#483023" roughness={0.83} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.024, centerZ]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={grain} roughness={0.84} metalness={0} />
      </mesh>
      {/* Leather-bound perimeter, kept outside the entire playing area. */}
      {[-1, 1].map((sign) => (
        <mesh key={'rail-x-' + sign} position={[centerX + sign * (width / 2 - 0.13), -0.008, centerZ]} castShadow receiveShadow>
          <boxGeometry args={[0.18, 0.065, depth - 0.26]} />
          <meshStandardMaterial color="#603b2b" roughness={0.91} />
        </mesh>
      ))}
      {[-1, 1].map((sign) => (
        <mesh key={'rail-z-' + sign} position={[centerX, -0.008, centerZ + sign * (depth / 2 - 0.13)]} castShadow receiveShadow>
          <boxGeometry args={[width - 0.26, 0.065, 0.18]} />
          <meshStandardMaterial color="#603b2b" roughness={0.91} />
        </mesh>
      ))}
      {([-1, 1] as const).flatMap((sx) => ([-1, 1] as const).map((sz) => (
        <group key={sx + ':' + sz} position={[centerX + sx * (width / 2 - 0.13), 0.035, centerZ + sz * (depth / 2 - 0.13)]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <circleGeometry args={[0.062, 20]} />
            <meshStandardMaterial color="#ba8952" metalness={0.58} roughness={0.37} />
          </mesh>
          <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.022, 0.026, 16]} />
            <meshBasicMaterial color="#684331" />
          </mesh>
        </group>
      )))}
    </group>
  );
}
