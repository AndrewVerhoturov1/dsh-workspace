import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useRef } from 'react';
import { MathUtils, Vector3 } from 'three';
import type { CameraPose } from './types';
import { calculateExtents, clampPose, fitCameraPose } from './sceneGeometry';

type OrbitHandle = React.ComponentRef<typeof OrbitControls>;

function readPose(target: Vector3, position: Vector3): CameraPose {
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  const distance = Math.max(0.001, Math.hypot(dx, dy, dz));
  return {
    target: { x: target.x, y: target.y, z: target.z },
    distance,
    azimuth: Math.atan2(dx, dz),
    elevation: Math.asin(MathUtils.clamp(dy / distance, -1, 1)),
  };
}

function positionFor(pose: CameraPose): Vector3 {
  const radial = pose.distance * Math.cos(pose.elevation);
  return new Vector3(
    pose.target.x + radial * Math.sin(pose.azimuth),
    pose.target.y + pose.distance * Math.sin(pose.elevation),
    pose.target.z + radial * Math.cos(pose.azimuth),
  );
}

interface CameraControllerProps {
  pose: CameraPose;
  visibleTiles: readonly { x: number; z: number }[];
  fitToken: number;
  onPoseChange: (pose: CameraPose) => void;
}

/** Orbit/pan/zoom with damping, finite limits and a smooth Fit Board command. */
export function CameraController({
  pose, visibleTiles, fitToken, onPoseChange,
}: CameraControllerProps): React.JSX.Element {
  const controls = useRef<OrbitHandle>(null);
  const animationGoal = useRef<CameraPose | null>(null);
  const wasFitting = useRef(false);
  const lastExternalPose = useRef('');
  const { camera, size, invalidate } = useThree();
  const bounds = calculateExtents(visibleTiles);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const applyPose = useCallback((next: CameraPose) => {
    const ctrl = controls.current;
    if (!ctrl) return;
    const clamped = clampPose(next, boundsRef.current);
    ctrl.target.set(clamped.target.x, clamped.target.y, clamped.target.z);
    camera.position.copy(positionFor(clamped));
    ctrl.update();
    invalidate();
  }, [camera, invalidate]);

  useEffect(() => {
    // UI redraws during hover must not reset a user's in-progress orbit.
    const signature = JSON.stringify(pose);
    if (lastExternalPose.current === signature) return;
    lastExternalPose.current = signature;
    applyPose(pose);
  }, [applyPose, pose]);

  useEffect(() => {
    if (fitToken === 0) return;
    animationGoal.current = fitCameraPose(visibleTiles, size.width / Math.max(1, size.height));
    wasFitting.current = true;
    invalidate();
    // UI explicitly initiates fits. Board extensions alone do not recenter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken, invalidate, size.height, size.width]);

  useFrame((state, delta) => {
    const goal = animationGoal.current;
    const ctrl = controls.current;
    if (!goal || !ctrl) return;
    const desired = positionFor(goal);
    const step = 1 - Math.exp(-Math.min(delta, 0.08) * 6.2);
    state.camera.position.lerp(desired, step);
    ctrl.target.lerp(new Vector3(goal.target.x, goal.target.y, goal.target.z), step);
    ctrl.update();
    if (state.camera.position.distanceToSquared(desired) < 0.0007
      && ctrl.target.distanceToSquared(new Vector3(goal.target.x, goal.target.y, goal.target.z)) < 0.0003) {
      state.camera.position.copy(desired);
      ctrl.target.set(goal.target.x, goal.target.y, goal.target.z);
      ctrl.update();
      animationGoal.current = null;
      if (wasFitting.current) onPoseChange(readPose(ctrl.target, state.camera.position));
      wasFitting.current = false;
    } else {
      state.invalidate();
    }
  });

  const handleEnd = () => {
    const ctrl = controls.current;
    if (!ctrl) return;
    const next = clampPose(readPose(ctrl.target, camera.position), boundsRef.current);
    applyPose(next);
    onPoseChange(next);
  };

  const handleChange = () => {
    const ctrl = controls.current;
    if (!ctrl || animationGoal.current) return;
    const current = readPose(ctrl.target, camera.position);
    const bounded = clampPose(current, boundsRef.current);
    if (
      current.target.x !== bounded.target.x
      || current.target.y !== bounded.target.y
      || current.target.z !== bounded.target.z
    ) {
      const previous = ctrl.target.clone();
      ctrl.target.set(bounded.target.x, bounded.target.y, bounded.target.z);
      camera.position.add(ctrl.target.clone().sub(previous));
      ctrl.update();
    }
  };

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableRotate enablePan enableZoom enableDamping
      dampingFactor={0.075} rotateSpeed={0.63} panSpeed={0.76} zoomSpeed={0.86}
      minDistance={1.65} maxDistance={90}
      minPolarAngle={Math.PI * 0.04}
      maxPolarAngle={Math.PI * (0.5 - 1 / 7)}
      screenSpacePanning={false}
      onStart={() => { animationGoal.current = null; wasFitting.current = false; }}
      onChange={handleChange}
      onEnd={handleEnd}
    />
  );
}
