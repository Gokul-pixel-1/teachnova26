// Customer-facing service names for raw API routes. Used by the public status
// page and the business reports, so customers read "Sign in" — never an
// internal path, file name or stack detail.

export interface PublicService {
  id: string
  label: string
  description: string
}

export const PUBLIC_SERVICES: PublicService[] = [
  { id: 'signin', label: 'Sign in', description: 'Logging in and account sessions' },
  { id: 'feed', label: 'Home feed', description: 'Loading posts on the home page' },
  { id: 'publish', label: 'Publishing', description: 'Creating new posts' },
  { id: 'comments', label: 'Comments', description: 'Reading and writing comments' },
  { id: 'projects', label: 'Projects', description: 'Project pages and showcases' },
  { id: 'platform', label: 'Platform', description: 'Profiles, likes and everything else' },
]

const byId = new Map(PUBLIC_SERVICES.map((s) => [s.id, s]))

export function serviceFor(endpoint: string | null | undefined, method: string | null | undefined): PublicService {
  const path = (endpoint ?? '').split('?')[0]
  const verb = (method ?? 'GET').toUpperCase()
  let id = 'platform'
  if (path.startsWith('/api/auth') || path === '/login' || path === '/signup') id = 'signin'
  else if (/^\/api\/posts\/[^/]+\/comments/.test(path) || path.startsWith('/api/comments')) id = 'comments'
  else if (path === '/api/posts' && verb === 'POST') id = 'publish'
  else if (path === '/api/posts' || path === '/' || path.startsWith('/feed')) id = 'feed'
  else if (path.startsWith('/api/projects') || path.startsWith('/projects')) id = 'projects'
  return byId.get(id) ?? PUBLIC_SERVICES[PUBLIC_SERVICES.length - 1]
}
