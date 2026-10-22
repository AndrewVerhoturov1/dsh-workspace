import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasTexture } from 'three';

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setImage: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useState: () => [null, hooks.setImage],
}));
import { SceneLabel } from './SceneLabel';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  hooks.effects.length = 0;
  hooks.setImage.mockClear();
});

describe('native label texture lifecycle', () => {
  it('allocates only after commit and disposes each StrictMode effect instance', () => {
    const context = {
      measureText: vi.fn(() => ({ width: 110 })),
      fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
    };
    const createElement = vi.fn(() => ({ width: 0, height: 0, getContext: () => context }));
    vi.stubGlobal('document', { createElement });
    const dispose = vi.spyOn(CanvasTexture.prototype, 'dispose');
    expect(SceneLabel({ text: 'field: field-1', position: [0, 0.1, 0] })).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(hooks.effects).toHaveLength(1);
    const effect = hooks.effects[0]!;
    const firstCleanup = effect();
    expect(hooks.setImage).toHaveBeenCalledTimes(1);
    const first = hooks.setImage.mock.calls[0]![0] as { texture: CanvasTexture; aspect: number };
    expect(first.texture).toBeInstanceOf(CanvasTexture);
    expect(first.aspect).toBe(128 / 38);
    expect(context.fillText).toHaveBeenCalledWith('field: field-1', 64, 19);
    expect(typeof firstCleanup).toBe('function');
    if (typeof firstCleanup === 'function') firstCleanup();
    expect(dispose).toHaveBeenCalledTimes(1);
    const secondCleanup = effect();
    const second = hooks.setImage.mock.calls[1]![0] as { texture: CanvasTexture };
    expect(second.texture).not.toBe(first.texture);
    if (typeof secondCleanup === 'function') secondCleanup();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
