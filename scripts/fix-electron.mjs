// Self-heal the local Electron install (runs as our `postinstall`).
//
// Two failure modes seen with pnpm (hoisted) + some volumes:
//   1. electron's `extract-zip` writes only a stub `dist/` (no Frameworks) so
//      the binary can't run ("Library not loaded: Electron Framework").
//   2. `path.txt` is never written, so `require('electron')` throws.
// This script completes the extraction from the @electron/get cache using the
// system `unzip` (which handles the .app bundle + symlinks correctly) and then
// writes `path.txt`. It is a no-op once the install is healthy.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)

function execRelPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

// On macOS the heavy part of the bundle is the framework; use it as a
// "fully extracted" sentinel.
function bundleComplete(distDir) {
  if (process.platform !== 'darwin') return existsSync(join(distDir, execRelPath()))
  return existsSync(join(distDir, 'Electron.app/Contents/Frameworks/Electron Framework.framework'))
}

function findCachedZip(version) {
  if (process.platform !== 'darwin') return null
  const cacheRoot = process.env.electron_config_cache || join(homedir(), 'Library/Caches/electron')
  const wanted = `electron-v${version}-darwin-${process.arch}.zip`
  if (!existsSync(cacheRoot)) return null
  // zips may sit at the cache root or one level down in hashed dirs
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === wanted) return join(cacheRoot, entry.name)
    if (entry.isDirectory()) {
      const nested = join(cacheRoot, entry.name, wanted)
      if (existsSync(nested)) return nested
    }
  }
  return null
}

try {
  const dir = dirname(require.resolve('electron/package.json'))
  const { version } = require('electron/package.json')
  const distDir = join(dir, 'dist')
  const pathTxt = join(dir, 'path.txt')
  const rel = execRelPath()

  if (!bundleComplete(distDir)) {
    const zip = findCachedZip(version)
    if (zip) {
      console.log(`[fix-electron] incomplete bundle; extracting ${zip}`)
      rmSync(distDir, { recursive: true, force: true })
      mkdirSync(distDir, { recursive: true })
      execFileSync('unzip', ['-o', '-q', zip, '-d', distDir], { stdio: 'inherit' })
    } else {
      console.warn(
        `[fix-electron] bundle incomplete and no cached zip for v${version}-${process.arch}; ` +
          `run \`pnpm rebuild electron\` (needs network).`
      )
    }
  }

  if (bundleComplete(distDir) && !existsSync(pathTxt)) {
    writeFileSync(pathTxt, rel)
    console.log(`[fix-electron] wrote path.txt -> ${rel}`)
  }
} catch (e) {
  console.warn(`[fix-electron] skipped: ${e instanceof Error ? e.message : String(e)}`)
}
