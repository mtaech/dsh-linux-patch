import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopWindowIcon } from '../src/window-icon.ts'

/** Electron surface the icon helper reads. */
const electron = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => '/desktop-app',
  created: [] as string[],
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return electron.isPackaged }, getAppPath: () => electron.getAppPath() },
  nativeImage: { createFromPath: (path: string) => { electron.created.push(path); return { path } } },
}))

/** Run one body with a packaged resource directory, which plain Node does not carry. */
function withResourcesPath<T>(body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: '/packaged-resources', configurable: true })
  try {
    return body()
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process, 'resourcesPath')
    else Object.defineProperty(process, 'resourcesPath', descriptor)
  }
}

beforeEach(() => { electron.created.length = 0; electron.isPackaged = false })
afterEach(() => { vi.resetModules() })

describe('desktop window icon', () => {
  it.each(['darwin', 'win32'] as const)('leaves %s windows without an icon option', (platform) => {
    expect(desktopWindowIcon(platform)).toEqual({})
    expect(electron.created).toEqual([])
  })

  it('reads the packaged resource icon the window manager takes from the window', () => {
    electron.isPackaged = true
    withResourcesPath(() => {
      expect(desktopWindowIcon('linux')).toEqual({ icon: { path: join('/packaged-resources', 'icon.png') } })
    })
  })

  it('reads the application resources during development and reuses the decoded image', () => {
    const first = desktopWindowIcon('linux')
    // The decoded image is reused; the option object around it is rebuilt per window.
    expect(desktopWindowIcon('linux').icon).toBe(first.icon)
    expect(desktopWindowIcon('linux')).toEqual({ icon: { path: join('/desktop-app', 'resources', 'icon-windows.png') } })
    expect(electron.created).toEqual([join('/desktop-app', 'resources', 'icon-windows.png')])
  })
})
