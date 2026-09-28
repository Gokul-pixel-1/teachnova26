import 'server-only'

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// Sandbox (test environment) for the UX Suggestion Agent: a SEPARATE copy of
// the BuildHub frontend served by its own `next dev --webpack` on UX_SANDBOX_PORT
// (default 3100). Candidate UI changes are written ONLY into this copy and
// measured there by simulated users (lib/server/ux/simulate.ts); the real
// source tree is never touched until a human approves.
//
// Isolation:
//   - lives outside the project (default ~/buildhub-sandbox/frontend);
//   - node_modules is a junction to the real one (no second install);
//   - it gets a minimal, hand-built environment: no Gmail, Telegram, Groq or
//     other credentials are inherited, auto-repair/fault injection/auto
//     suggestion are off, and UX_SANDBOX_MODE makes its behaviour-event
//     endpoint ignore everything, so simulated visits never count as users.
//   - it shares the database read path (pages need real data to render).

const SYNC_DIRS = ['app', 'components', 'lib', 'public']
const SYNC_FILES = ['package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'proxy.ts', 'next-env.d.ts']
const PASSTHROUGH_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]

export function sandboxEnabled(): boolean {
  const raw = (process.env.UX_SANDBOX ?? '').trim().toLowerCase()
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no')
}

export function sandboxPort(): number {
  const port = Number.parseInt(process.env.UX_SANDBOX_PORT ?? '', 10)
  return Number.isFinite(port) && port > 0 ? port : 3100
}

export function sandboxBaseUrl(): string {
  return `http://localhost:${sandboxPort()}`
}

export function sandboxDir(): string {
  return process.env.UX_SANDBOX_DIR?.trim() || join(homedir(), 'buildhub-sandbox', 'frontend')
}

export function sandboxDataDir(): string {
  return join(process.cwd(), '.data', 'ux-sandbox')
}

function copyIfChanged(src: string, dest: string): boolean {
  const s = statSync(src)
  if (existsSync(dest)) {
    const d = statSync(dest)
    if (d.size === s.size && d.mtimeMs >= s.mtimeMs) return false
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  return true
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** Mirrors the real source tree into the sandbox, copying only changed files
 * (and removing files that no longer exist) so its dev server stays warm. */
export function syncSandboxSource(): { copied: number; removed: number } {
  const root = process.cwd()
  const target = sandboxDir()
  let copied = 0
  let removed = 0
  for (const d of SYNC_DIRS) {
    const srcDir = join(root, d)
    if (!existsSync(srcDir)) continue
    const srcFiles = walk(srcDir)
    const keep = new Set(srcFiles.map((f) => relative(root, f)))
    for (const f of srcFiles) if (copyIfChanged(f, join(target, relative(root, f)))) copied += 1
    const destDir = join(target, d)
    if (existsSync(destDir)) {
      for (const f of walk(destDir)) {
        if (!keep.has(relative(target, f))) {
          rmSync(f, { force: true })
          removed += 1
        }
      }
    }
  }
  for (const f of SYNC_FILES) {
    const src = join(root, f)
    if (existsSync(src) && copyIfChanged(src, join(target, f))) copied += 1
  }
  return { copied, removed }
}

/** Writes one file (repo-relative path) into the sandbox copy only. */
export function writeSandboxFile(relativePath: string, content: string): void {
  const dest = join(sandboxDir(), relativePath)
  // Rewriting identical bytes still makes the dev server recompile and reload.
  if (existsSync(dest) && readFileSync(dest, 'utf8') === content) return
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content, 'utf8')
}

/** Waits until the sandbox serves `path` successfully twice in a row, so a
 * recompile triggered by the source sync has finished before measuring. */
export async function waitForSandboxStable(path: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline && streak < 2) {
    try {
      const res = await fetch(`${sandboxBaseUrl()}${path}`, { signal: AbortSignal.timeout(60_000), redirect: 'manual' })
      streak = res.status < 500 ? streak + 1 : 0
    } catch {
      streak = 0
    }
    if (streak < 2) await new Promise((r) => setTimeout(r, 1500))
  }
}

/** Puts one sandbox file back to the real source's current bytes. */
export function restoreSandboxFile(relativePath: string): void {
  const src = join(process.cwd(), relativePath)
  if (existsSync(src)) writeSandboxFile(relativePath, readFileSync(src, 'utf8'))
}

function prepareSandboxDir(): void {
  const target = sandboxDir()
  mkdirSync(target, { recursive: true })
  const modules = join(target, 'node_modules')
  if (!existsSync(modules)) symlinkSync(join(process.cwd(), 'node_modules'), modules, 'junction')
  writeFileSync(
    join(target, '.env.local'),
    [
      '# Generated by lib/server/ux/sandbox.ts — sandbox copy of BuildHub.',
      '# No credentials here on purpose: it can never email, alert or call AI.',
      `DATABASE_URL=${process.env.DATABASE_URL ?? ''}`,
      'UX_SANDBOX_MODE=true',
      'UX_AUTO_SUGGEST=false',
      'UX_SANDBOX=false',
      'AUTO_REPAIR=false',
      'FAULT_INJECTION_ENABLED=false',
      'AUTH_GUARD_ENABLED=false',
      'NEXT_TELEMETRY_DISABLED=1',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function sandboxResponds(): Promise<boolean> {
  try {
    const res = await fetch(`${sandboxBaseUrl()}/`, { signal: AbortSignal.timeout(90_000), redirect: 'manual' })
    return res.status < 500
  } catch {
    return false
  }
}

async function portOpen(): Promise<boolean> {
  try {
    await fetch(`${sandboxBaseUrl()}/favicon.ico`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

const START_KEY = '__buildhub_ux_sandbox_start__'
const g = globalThis as unknown as Record<string, Promise<void> | undefined>

/** Ensures the sandbox server is running on the latest source. Starts it
 * (first time ~30–90 s while Next compiles) when it is not up. */
export async function ensureSandbox(): Promise<void> {
  prepareSandboxDir()
  syncSandboxSource()
  if (await portOpen()) {
    if (await sandboxResponds()) return
    throw new Error(`Port ${sandboxPort()} is in use but the sandbox is not responding.`)
  }
  if (!g[START_KEY]) {
    g[START_KEY] = (async () => {
      mkdirSync(sandboxDataDir(), { recursive: true })
      const log = openSync(join(sandboxDataDir(), 'sandbox-server.log'), 'a')
      // Built from scratch: never inherit this server's secrets.
      const env = {} as NodeJS.ProcessEnv
      for (const name of PASSTHROUGH_ENV) {
        const value = process.env[name]
        if (value) env[name] = value
      }
      const nextBin = join(sandboxDir(), 'node_modules', 'next', 'dist', 'bin', 'next')
      // webpack, not Turbopack: Turbopack refuses a node_modules junction that
      // points outside the sandbox root; webpack follows it normally.
      const child = spawn(process.execPath, [nextBin, 'dev', '--webpack', '-p', String(sandboxPort())], {
        cwd: sandboxDir(),
        env,
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
      })
      child.unref()
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        if (await sandboxResponds()) return
        await new Promise((r) => setTimeout(r, 2000))
      }
      throw new Error('Sandbox server did not start within 4 minutes (see .data/ux-sandbox/sandbox-server.log).')
    })().finally(() => {
      g[START_KEY] = undefined
    })
  }
  await g[START_KEY]
}
