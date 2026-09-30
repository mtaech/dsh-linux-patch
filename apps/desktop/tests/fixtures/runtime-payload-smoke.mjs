/** Exercise filtered Desktop native and HTML dependencies under its Electron Node runtime. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the filtered resources/dsh directory')
const root = resolve(runtime)
const descriptor = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
assert.equal(process.versions.node, descriptor.release.nodeVersion, 'Run with the Electron Node runtime version')
assert.equal(process.platform, descriptor.platform)
assert.equal(process.arch, descriptor.arch)
const resourcesRuntime = process.argv[3] ?? join(dirname(root), 'runtime')
const requireRuntime = createRequire(join(root, 'package.json'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-payload-'))

/** Run a package script with only the shipped node launcher available on PATH. */
function checkPnpm() {
  const bin = join(resourcesRuntime, 'bin')
  const pnpm = join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.mjs')
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'desktop-node-script-smoke', private: true, scripts: { check: 'node check.cjs' },
  }))
  writeFileSync(join(scratch, 'check.cjs'), `
const assert = require('node:assert/strict')
assert.equal(process.execPath, ${JSON.stringify(process.execPath)})
assert.ok(process.versions.electron)
assert.ok(process.execArgv.includes('--expose-internals'))
assert.equal(typeof require('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
console.log('desktop-node-script-ok')
`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir|comspec)$/iu.test(name)))
  const systemBin = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
  // This dependency-free fixture checks script launch, without pnpm's implicit install and update-network check.
  const output = execFileSync(process.execPath, ['--expose-internals', pnpm, 'run', 'check'], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000,
    env: { ...environment, pnpm_config_verify_deps_before_run: 'false',
      ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${bin}${delimiter}${systemBin}`, HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
  })
  assert.match(output, /desktop-node-script-ok/u)
}

/** Spawn only a fixed Node program and await the terminal's drained exit event. */
async function checkPty() {
  const pty = requireRuntime('node-pty')
  const script = join(scratch, 'pty.cjs')
  writeFileSync(script, "process.stdout.write('runtime-payload-pty-ok\\n')\n", { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|ELECTRON_RUN_AS_NODE)$/iu.test(name)
  )))
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
  env.DSH_DESKTOP_NODE_EXECUTABLE = process.execPath
  env.PATH = `${join(resourcesRuntime, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`
  // A Windows GUI executable needs a console-owning shell when launched inside ConPTY.
  const executable = process.platform === 'win32' ? process.env.ComSpec : process.execPath
  const args = process.platform === 'win32' ? ['/d', '/c', 'node', script] : [script]
  const terminal = pty.spawn(executable, args, { cwd: scratch, env, cols: 80, rows: 24 })
  let output = ''
  let exited = false
  let timedOut = false
  let exitSubscription
  const exit = new Promise(resolveExit => {
    exitSubscription = terminal.onExit(event => {
      exited = true
      resolveExit(event)
    })
  })
  const dataSubscription = terminal.onData(data => { output += data })
  let timer
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Packaged PTY did not exit within 45 seconds'))
      }, 45_000)
    })
    const result = await Promise.race([exit, deadline])
    assert.equal(timedOut, false)
    assert.ok(result.signal === undefined || result.signal === 0, 'PTY exited without a signal')
    assert.equal(result.exitCode, 0)
    assert.match(output, /runtime-payload-pty-ok/u)
  } finally {
    clearTimeout(timer)
    dataSubscription.dispose()
    try {
      // node-pty's Windows natural-exit event closes output but leaves its ConPTY worker owned by kill().
      if (!exited || process.platform === 'win32') terminal.kill()
      await exit
    } finally {
      exitSubscription.dispose()
    }
  }
}

/** Exercise grep and glob operations with the search tool's resolved native executable. */
async function checkSearch() {
  const { resolveRgPath } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-tool-fs-search')).href)
  const executable = await resolveRgPath()
  const name = 'ripgrep-smoke.txt'
  const marker = 'desktop-ripgrep-smoke'
  writeFileSync(join(scratch, name), `${marker}\n`, { flag: 'wx', mode: 0o600 })
  const run = args => execFileSync(executable, ['--no-config', ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir)$/iu.test(name))),
  }).trim().replaceAll('\\', '/')
  assert.equal(run(['--no-heading', '--no-filename', '--line-number', '--fixed-strings', '--', marker, name]), `1:${marker}`)
  assert.equal(run(['--files', '--glob', name, '.']), `./${name}`)
}

/** Resolve one system function through Koffi's packaged native module. */
function checkKoffi() {
  const koffi = requireRuntime('koffi')
  const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const getPid = process.platform === 'win32'
      ? library.func('uint32_t __stdcall GetCurrentProcessId(void)')
      : library.func('int getpid(void)')
    assert.equal(getPid(), process.pid)
  } finally {
    library.unload()
  }
}

/** One-pixel PNG that every raster check decodes. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
)

/**
 * Decode and normalize a PNG through the packaged attachment store on Linux.
 *
 * Electron links the system GLib over the GLib that Sharp's prebuilt libvips
 * links statically, so decoding an image inside an Electron Linux process
 * crashes it (electron/electron#46323). The store runs that work in the
 * bundled plain Node instead, which is what this check exercises.
 */
async function checkPackagedRasterStore() {
  const { default: LocalAttachmentStore } = await import(
    pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = requireRuntime('@deepseek-ai/cordis')
  const service = new LocalAttachmentStore(new Context(), {
    dshHome: scratch,
    rasterNode: join(resourcesRuntime, 'primary-runtime', 'dependencies', 'node', 'bin', 'node'),
  })
  const ref = await service.saveImage({ data: PIXEL_PNG, mediaType: 'image/png' })
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.width, 1)
  assert.equal(ref.height, 1)
  const stored = await service.readImage(ref)
  assert.deepEqual(Buffer.from(stored.data), PIXEL_PNG)
}

/** Exercise packaged image decoding: in-process wherever Electron loads no conflicting
 * GLib, and through the bundled plain Node on Linux. */
async function checkRaster() {
  if (process.versions.electron && process.platform === 'linux') {
    await checkPackagedRasterStore()
    return
  }
  const sharp = requireRuntime('sharp')
  const pixel = Buffer.from([17, 103, 231])
  const png = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer()
  const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 1)
  assert.equal(decoded.info.height, 1)
  assert.equal(decoded.info.channels, 3)
  assert.deepEqual(decoded.data, pixel)
}

/** Exercise Domino parsing through the HTML converter and GFM plugin used by web_fetch. */
function checkHtml() {
  const Turndown = requireRuntime('turndown')
  const { gfm } = requireRuntime('@joplin/turndown-plugin-gfm')
  const converter = new Turndown({ bulletListMarker: '-' })
  converter.use(gfm)
  const markdown = converter.turndown('<p>A &amp; B &copy;</p><ul><li>first</li><li>second</li></ul>'
    + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>x</td><td>7</td></tr></tbody></table>')
  assert.match(markdown, /A & B ©/u)
  assert.match(markdown, /-\s+first\n-\s+second/u)
  assert.match(markdown, /\| Name \| Value \|/u)
  assert.match(markdown, /\| x\s+\| 7\s+\|/u)
}

try {
  const builtin = requireRuntime('node-addon-require-builtin')
  assert.equal(typeof builtin.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
  checkPnpm()
  checkKoffi()
  await checkRaster()
  checkHtml()
  await checkPty()
  await checkSearch()
} finally {
  // This private tree contains only fixture files; Windows may release handles after terminal exit.
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

// Natural event-loop drain includes node-pty's worker and console-list helper teardown.
process.once('beforeExit', () => {
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch,
    koffi: true, raster: true, html: true, pty: true, pnpm: true, grep: true, glob: true }))
})
