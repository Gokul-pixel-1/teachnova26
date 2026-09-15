import 'server-only'

// Phase 8 — deterministic "suspect location" hints for the real AI agents.
//
// Route prefixes map to the most likely source file that handled the request.
// This is a heuristic for the Fixer/Critic/Judge prompt context — never proof
// of a defect and never a line number. The heuristic is a pure table lookup so
// results are reproducible for the same route.
const ROUTE_SOURCE_MAP: Array<[prefix: string, file: string]> = [
  ['/api/auth/login', 'app/api/auth/login/route.ts'],
  ['/api/auth/register', 'app/api/auth/register/route.ts'],
  ['/api/auth/', 'app/api/auth/route.ts'],
  ['/api/posts/', 'app/api/posts/[id]/route.ts'],
  ['/api/posts', 'app/api/posts/route.ts'],
  ['/api/projects/', 'app/api/projects/[id]/route.ts'],
  ['/api/projects', 'app/api/projects/route.ts'],
  ['/api/comments/', 'app/api/comments/[id]/route.ts'],
  ['/api/comments', 'app/api/comments/route.ts'],
  ['/api/likes/', 'app/api/likes/[id]/route.ts'],
  ['/api/likes', 'app/api/likes/route.ts'],
  ['/api/incidents/', 'app/api/incidents/[id]/route.ts'],
  ['/api/incidents', 'app/api/incidents/route.ts'],
  ['/api/logs', 'app/api/logs/route.ts'],
  ['/api/observability/summary', 'app/api/observability/summary/route.ts'],
  ['/api/security/', 'app/api/security/route.ts'],
  ['/api/health', 'app/api/health/route.ts'],
  ['/api/search', 'app/api/search/route.ts'],
  ['/api/settings', 'app/api/settings/route.ts'],
  ['/api/profile', 'app/api/profile/route.ts'],
]

const FALLBACK = 'unresolved — no source file hint available for this route'

export function suspectSourceFor(route: string | null | undefined): string {
  if (!route) return 'unresolved — no route captured for this request'
  // Concrete comment routes (/api/posts/<id>/comments) belong to the
  // comments handler, not the generic post-detail prefix below.
  if (route.split('?')[0].endsWith('/comments')) return 'app/api/posts/[id]/comments/route.ts'
  // Longest prefix wins so `/api/posts/[id]` matches before `/api/posts`.
  const hits = ROUTE_SOURCE_MAP.filter(([prefix]) => route.startsWith(prefix))
  if (hits.length === 0) return FALLBACK
  hits.sort((a, b) => b[0].length - a[0].length)
  return hits[0][1]
}