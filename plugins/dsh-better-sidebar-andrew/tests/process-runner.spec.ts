import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { spawnHidden, windowsSafeSpawnOptions } from '../src/process-runner.ts'

describe('Windows process runner policy', () => {
  it('forces hidden Windows children even when a caller passes false', () => {
    expect(windowsSafeSpawnOptions({ detached: true, windowsHide: false }, 'win32'))
      .toEqual({ detached: true, windowsHide: true })
  })

  it('leaves POSIX spawn options unchanged', () => {
    const options = { detached: true, windowsHide: false }
    expect(windowsSafeSpawnOptions(options, 'linux')).toBe(options)
    expect(windowsSafeSpawnOptions(options, 'darwin')).toBe(options)
  })

  it('passes forced hidden options to the real spawn wrapper', () => {
    spawnMock.mockReturnValue({})

    spawnHidden('git', ['status'], { detached: true, windowsHide: false })

    expect(spawnMock).toHaveBeenCalledWith('git', ['status'], {
      detached: true,
      windowsHide: true,
    })
  })
})
