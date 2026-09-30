/** Resolve the packaged Office kit closure from its complete, unpacked resource directories. */
import { registerHooks, type ModuleHooks } from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Locate the archive containing a packaged runtime.
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns Parent archive path, or undefined for a prepared directory.
 */
export function runtimeArchivePath(runtimeDir: string): string | undefined {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/**
 * Keep the whole Office kit closure on physical paths for every consumer.
 *
 * Electron serves ASAR reads transparently, but a file-existence probe inside
 * the archive answers "present" for a path that was never unpacked, and the
 * kit's engine selection reads exactly such a probe: it would conclude that an
 * uninstalled native engine exists and refuse to fall back to WASM. Resolving
 * the kit, its engines, and their asset reads to the unpacked copies keeps
 * those probes and native child processes honest.
 * Hooks apply only to this thread; worker threads must install their own resolver.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
 */
export function installOfficeEngineResolution(runtimeDir: string): ModuleHooks | undefined {
  if (runtimeArchivePath(runtimeDir) === undefined) return undefined
  const root = realpathSync(runtimeDir)
  const archive = dirname(root)
  const source = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit')).href
  const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), 'node_modules', '@deepseek-ai', 'libreoffice-kit')).href
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!/^@deepseek-ai\/libreoffice-kit(?:$|[-/])/u.test(specifier)) return nextResolve(specifier, context)
      const resolved = nextResolve(specifier, context)
      const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href
      if (!canonical.startsWith(source)) {
        if (canonical.startsWith(pathToFileURL(archive + '/').href)) {
          throw new Error(`desktop Office kit resolved outside the runtime package directory: ${resolved.url}`)
        }
        return resolved
      }
      const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)))
      return { ...resolved, url: pathToFileURL(physical).href }
    },
  })
}
