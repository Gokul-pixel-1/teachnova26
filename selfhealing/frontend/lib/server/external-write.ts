import 'server-only'

// Phase 9 — external file writes for the fault-injection + repair harness.
//
// `next dev` (Turbopack) suppresses file-change events for writes performed by
// the Next server process itself, so a route module edited in-process (fault
// activation, engine patch apply, rollback) is never recompiled before the next
// request — validation probes then run against stale code and produce false
// ROLLED_BACK/AI_REPAIR_FAILED results.
//
// Writing the same content from a short-lived CHILD process produces
// file-watch events the dev server does observe, so the edited module is
// recompiled before validation/probes re-run the failing request.

import { spawn } from 'node:child_process'

const WRITER_SCRIPT = `
  const fs = require('fs');
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => { fs.writeFileSync(process.argv[1], data, 'utf8'); });
  process.stdin.on('error', () => process.exit(1));
`

/** Writes a file from a child process so the dev file-watcher recompiles it. */
export function writeFileExternally(absPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', WRITER_SCRIPT, absPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    let settled = false
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else reject(new Error(`external write exited with code ${code}`))
    })
    child.stdin.end(content)
  })
}