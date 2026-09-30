/** The window icon every Desktop window presents to the window manager. */

import { join } from 'node:path'
import { app, nativeImage } from 'electron'

let cached: { path: string; image: Electron.NativeImage } | undefined

/**
 * Build the window icon option shared by every Desktop window.
 *
 * Linux window managers take a window's taskbar icon from the window itself:
 * Wayland delivers it through `xdg-toplevel-icon-v1` and X11 carries it as
 * `_NET_WM_ICON`. A window that sets no icon shows a generic placeholder even
 * when a matching desktop entry is installed. macOS and Windows take their icon
 * from the application bundle or executable and receive no option.
 * @param platform - operating system hosting Electron.
 * @returns BrowserWindow icon options for this platform.
 */
export function desktopWindowIcon(platform: NodeJS.Platform = process.platform): { icon?: Electron.NativeImage } {
  if (platform === 'darwin' || platform === 'win32') return {}
  const path = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    // Development packages resources from the application directory; the Windows
    // render is the square artwork Linux uses too.
    : join(app.getAppPath(), 'resources', 'icon-windows.png')
  if (cached?.path !== path) cached = { path, image: nativeImage.createFromPath(path) }
  return { icon: cached.image }
}
