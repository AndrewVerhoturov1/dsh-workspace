import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { getTileCatalog } from '../game';
import { SceneCanvas } from './SceneCanvas';
import { TileDiagnosticMarkers } from './RegionMarkers';
import { SceneLabel } from './SceneLabel';

const canvasOptions: Array<Record<string, unknown>> = [];

vi.mock('@react-three/fiber', async () => {
  const React = await import('react');
  return {
    Canvas: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
      canvasOptions.push(props);
      return React.createElement('div', { 'data-canvas': 'r3f' }, children);
    },
    useThree: () => ({ gl: { domElement: {} } }),
  };
});
vi.mock('./BoardFallback2D', () => ({ BoardFallback2D: () => createElement('div', null, '2d') }));
vi.mock('./CameraController', () => ({ CameraController: () => null }));
vi.mock('./MeepleMesh', () => ({ MeepleMesh: () => null }));
vi.mock('./TableEnvironment', () => ({ TableEnvironment: () => null }));
vi.mock('./TileMesh', () => ({ TILE_TOP_Y: 0, TileMesh: () => null }));
vi.mock('./RegionMarkers', async () => {
  const actual = await vi.importActual<typeof import('./RegionMarkers')>('./RegionMarkers');
  return { ...actual, FollowerRegionMarker: () => null };
});

function propsForScene() {
  const catalog = getTileCatalog();
  return {
    board: { tiles: [], meeples: [], players: [], phase: 'tile', pendingTile: null } as never,
    definitions: catalog.definitions,
    legalPlacements: [], followerTargets: [], selectedRotation: 0 as const,
    camera: { target: { x: 0, y: 0, z: 0 }, distance: 8, azimuth: 0, elevation: 1 },
    onPlacementPick: vi.fn(), onRegionPick: vi.fn(), onHoverChange: vi.fn(),
    onCameraChange: vi.fn(), onRenderError: vi.fn(),
  };
}

describe('scene runtime regressions', () => {
  it('keeps the configured 3D Canvas without a false HTML fallback notifier', () => {
    canvasOptions.length = 0;
    const markup = renderToStaticMarkup(createElement(SceneCanvas, propsForScene()));
    expect(markup).toContain('data-canvas="r3f"');
    expect(canvasOptions).toHaveLength(1);
    expect(canvasOptions[0]).toMatchObject({
      shadows: 'soft', dpr: [1, 1.75], frameloop: 'demand',
      gl: { antialias: true, powerPreference: 'high-performance', alpha: false },
    });
    expect(canvasOptions[0]).not.toHaveProperty('fallback');
    expect(markup).not.toContain('WebGL недоступен');
  });

  it('composes diagnostic overlays from native scene labels', () => {
    const tile = getTileCatalog().definitions[0]!;
    const tree = TileDiagnosticMarkers({ tile, showAnchors: true, showPorts: true });
    const labels: ReactElement[] = [];
    const functionTypes = new Set<unknown>();
    const visit = (node: ReactNode): void => {
      for (const child of Children.toArray(node)) {
        if (!isValidElement(child)) continue;
        if (child.type === SceneLabel) labels.push(child);
        if (typeof child.type === 'function') functionTypes.add(child.type);
        visit((child.props as { children?: ReactNode }).children);
      }
    };
    visit((tree.props as { children?: ReactNode }).children);

    const fields = tile.regions.filter((region) => region.kind === 'field');
    const expectedLabels = tile.regions.length + fields.reduce((count, field) => count + field.ports.length, 0);
    expect(labels).toHaveLength(expectedLabels);
    expect([...functionTypes]).toEqual([SceneLabel]);
    const texts = labels.map((label) => (label.props as { text: string }).text);
    for (const region of tile.regions) expect(texts).toContain(region.kind + ': ' + region.id);
    for (const field of fields) for (const port of field.ports) expect(texts).toContain(port);
    for (const label of labels) {
      const position = (label.props as { position: unknown }).position;
      expect(Array.isArray(position)).toBe(true);
      expect(position).toHaveLength(3);
    }
  });
});
