import 'server-only'

import { readRealFile, repoRelativeFile } from '@/lib/server/repair/evidence'

// Lightweight validation for an applied UX suggestion. The bug-repair engine's
// runValidationProbes (lib/server/repair/validation.ts) replays the incident's
// specific failing HTTP request — there is no equivalent single "failing
// request" for a UI reposition, so this is intentionally simpler:
//   1. Write-integrity: the file on disk matches what we intended to write.
//   2. If the file is a routable page (app/**/page.tsx, no dynamic segments),
//      fetch that route once and require a non-5xx response.
//   3. Otherwise (a shared component with no route of its own) validate on
//      write-success alone — documented as deliberately lighter.
// Any failure here tells the caller to roll back.

export interface UxValidationResult {
  ok: boolean
  detail: string
}

function appBaseUrl(): string {
  return (process.env.COMMAND_CENTER_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/** Derives a fetchable route path from an app/**\/page.tsx file, or null when
 * the file isn't a routable page or contains a dynamic segment we can't fill. */
function routeForPageFile(file: string): string | null {
  const relative = repoRelativeFile(file)
  if (!/^app\/.*\/page\.tsx$/.test(relative) && relative !== 'app/page.tsx') return null
  if (relative.includes('[')) return null // dynamic segment — no example value available
  // app/page.tsx is the home route "/" (no slash before "page.tsx" there).
  const withoutPrefix = relative.replace(/^app\//, '').replace(/(^|\/)page\.tsx$/, '')
  const segments = withoutPrefix
    .split('/')
    .filter((seg) => seg.length > 0 && !/^\(.*\)$/.test(seg)) // route groups are not part of the URL
  return `/${segments.join('/')}`
}

export async function runUxValidation(
  file: string,
  expectedContent: string,
  probePath: string | null = null,
): Promise<UxValidationResult> {
  const onDisk = readRealFile(file)
  if (!onDisk.ok || onDisk.content !== expectedContent) {
    return { ok: false, detail: 'write integrity check failed: on-disk bytes do not match the applied content.' }
  }

  // A page file probes its own route; a shared component probes a page that
  // renders it (from the component registry).
  const route = routeForPageFile(file) ?? probePath
  if (!route) {
    return { ok: true, detail: 'write verified; no page to probe, so no live HTTP check was run.' }
  }

  try {
    const res = await fetch(`${appBaseUrl()}${route}`, { signal: AbortSignal.timeout(30000), redirect: 'manual' })
    // A page that is suddenly "not found" is as broken as one that crashes.
    if (res.status >= 500 || res.status === 404) {
      return { ok: false, detail: `route probe ${route} returned ${res.status} after applying the change.` }
    }
    return { ok: true, detail: `write verified; route probe ${route} returned ${res.status}.` }
  } catch (err) {
    return {
      ok: false,
      detail: `route probe ${route} failed: ${err instanceof Error ? err.message : 'unknown error'}.`,
    }
  }
}
