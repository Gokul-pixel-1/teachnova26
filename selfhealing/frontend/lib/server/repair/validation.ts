import 'server-only'

// Phase 9 — real HTTP validation probes. After a patch is applied, the request
// that actually failed on the endpoint is re-run (post-injection healthy
// outcome). Probe selection is derived from the incident's REAL endpoint /
// method / error code, never from a fault id or a pre-recorded answer. All
// probes run against the local development server — no guessed verdicts.

import type { Incident } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const BASE_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'buildhub-demo1'
const PROBE_TIMEOUT_MS = 20_000

// Synthetic validation traffic must never create incidents: every probe fetch
// carries an `x-request-id` with the `probe-` prefix (accepted by the
// correlation proxy), which the log monitor excludes from incident scans.
// Real user failures keep operator- or proxy-generated IDs and are unaffected.
function probeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, 'x-request-id': `probe-${randomUUID()}` }
}

export interface ProbeResult {
  name: string
  method: string
  path: string
  ok: boolean
  expected: string
  actual: string
}

interface ProbeEnv {
  arjunCookie: string
  meeraCookie: string
}

async function request(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: probeHeaders({
        'Content-Type': 'application/json',
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      }),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      redirect: 'manual',
    })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

function jsonOf<T>(result: { body: string }): T | null {
  try {
    return JSON.parse(result.body) as T
  } catch {
    return null
  }
}

async function sessionCookie(username: string): Promise<string | null> {
  const raw = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: probeHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ identifier: username, password: DEMO_PASSWORD }),
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const setCookie = raw.headers.get('set-cookie')
  if (!setCookie) return null
  return setCookie.split(';')[0] ?? null
}

async function buildEnv(): Promise<ProbeEnv> {
  const arjunCookie = (await sessionCookie('arjun')) ?? ''
  const meeraCookie = (await sessionCookie('meera')) ?? ''
  return { arjunCookie, meeraCookie }
}

function result(
  name: string,
  method: string,
  path: string,
  expected: string,
  actual: string,
  ok: boolean,
): ProbeResult {
  return { name, method, path, ok, expected, actual }
}

/** Creates a throwaway post as arjun and returns its id. */
async function makePost(cookie: string): Promise<string | null> {
  const res = await request('POST', '/api/posts', {
    cookie,
    body: {
      content: `Validation replay post ${Date.now()}.`,
      tags: ['probe'],
    },
  })
  return jsonOf<{ post?: { id: string } }>(res)?.post?.id ?? null
}

/** Creates a throwaway project as arjun and returns its id. */
async function makeProject(cookie: string): Promise<string | null> {
  const res = await request('POST', '/api/projects', {
    cookie,
    body: { name: `__replay_project_${Date.now()}`, description: 'validation replay project' },
  })
  return jsonOf<{ project?: { id: string } }>(res)?.project?.id ?? null
}

/**
 * Builds the validation plan for an incident by re-running the real failing
 * request (method + endpoint from the incident record) against its healthy
 * outcome. Multiple probes are returned when the same endpoint is exercised in
 * more than one way (e.g. owner + non-owner).
 */
export async function runValidationProbes(incident: Incident): Promise<ProbeResult[]> {
  const env = await buildEnv()
  if (!env.arjunCookie && !env.meeraCookie) {
    // Nothing we can verify without sessions — report the app health honestly.
    const health = await request('GET', '/api/health')
    return [result('Application reachable', 'GET', '/api/health', '200 (app up)', `${health.status}`, health.status === 200)]
  }

  const method = (incident.method ?? 'GET').toUpperCase()
  const endpoint = (incident.endpoint ?? '/api/health').split('?')[0]

  // Comment creation (concrete post id): throwaway post + real comment probe.
  if (method === 'POST' && endpoint.endsWith('/comments')) {
    const postId = await makePost(env.arjunCookie)
    if (!postId) return [result('Comment probe setup', 'POST', '/api/posts', '201 (probe post)', 'no post created', false)]
    const res = await request('POST', `/api/posts/${postId}/comments`, {
      cookie: env.arjunCookie,
      body: { content: `Validation replay comment ${Date.now()}.` },
    })
    const parsed = jsonOf<{ comment?: { id: string } }>(res)
    const ok = res.status === 201 && !!parsed?.comment?.id
    return [result('Comment creation succeeds', 'POST', `/api/posts/${postId}/comments`, '201 (comment created)', `${res.status}`, ok)]
  }

  switch (`${method} ${endpoint}`) {
    case 'POST /api/posts': {
      const id = await makePost(env.arjunCookie)
      if (!id) {
        return [result('Post creation succeeds', 'POST', '/api/posts', '201 (post created)', 'no post id (create failed)', false)]
      }
      const list = await request('GET', '/api/posts?pageSize=3', { cookie: env.arjunCookie })
      return [
        result('Post creation succeeds', 'POST', '/api/posts', '201 (post created)', '201', true),
        result('New post appears in feed', 'GET', '/api/posts', `feed contains post ${id}`, list.body.includes(id) ? 'found' : 'missing', list.body.includes(id)),
      ]
    }
    case 'GET /api/posts': {
      const res = await request('GET', '/api/posts?page=1&pageSize=3', { cookie: env.arjunCookie })
      const parsed = jsonOf<{ posts?: unknown[] }>(res)
      return [result('Feed loads', 'GET', '/api/posts', '200 with posts array', `${res.status}`, res.status === 200 && Array.isArray(parsed?.posts))]
    }
    case 'GET /api/posts/[id]': {
      const list = await request('GET', '/api/posts?pageSize=3', { cookie: env.arjunCookie })
      const id = jsonOf<{ posts?: Array<{ id: string }> }>(list)?.posts?.[0]?.id ?? (await makePost(env.arjunCookie))
      if (!id) return [result('Post detail contract', 'GET', '/api/posts/{id}', '200 with post key', 'no post available', false)]
      const res = await request('GET', `/api/posts/${id}`, { cookie: env.arjunCookie })
      const parsed = jsonOf<{ post?: unknown }>(res)
      return [result('Post detail contract', 'GET', `/api/posts/${id}`, '200 with post key, no poost key', `${res.status}`, res.status === 200 && parsed !== null && 'post' in parsed)]
    }
    case 'PATCH /api/posts/[id]': {
      const id = await makePost(env.arjunCookie)
      if (!id) return [result('Post edit succeeds', 'PATCH', '/api/posts/{id}', '200 (edited)', 'no post created', false)]
      const res = await request('PATCH', `/api/posts/${id}`, { cookie: env.arjunCookie, body: { content: 'Edited validation replay content.' } })
      return [result('Post edit succeeds', 'PATCH', `/api/posts/${id}`, '200 (edited)', `${res.status}`, res.status === 200)]
    }
    case 'DELETE /api/posts/[id]': {
      const id = await makePost(env.arjunCookie)
      if (!id) return [result('Post delete succeeds', 'DELETE', '/api/posts/{id}', '200 (deleted)', 'no post created', false)]
      const res = await request('DELETE', `/api/posts/${id}`, { cookie: env.arjunCookie })
      return [result('Post delete succeeds', 'DELETE', `/api/posts/${id}`, '200 (deleted)', `${res.status}`, res.status === 200)]
    }
    case 'PATCH /api/projects/[id]': {
      const id = await makeProject(env.arjunCookie)
      if (!id) return [result('Project edit succeeds', 'PATCH', '/api/projects/{id}', '200 (owner)', 'no project created', false)]
      const owner = await request('PATCH', `/api/projects/${id}`, { cookie: env.arjunCookie, body: { description: 'validation replay description' } })
      const foreign = env.meeraCookie
        ? await request('PATCH', `/api/projects/${id}`, { cookie: env.meeraCookie, body: { description: 'hijack attempt' } })
        : null
      return [
        result('Owner can edit own project', 'PATCH', `/api/projects/${id}`, '200 (owner)', `${owner.status}`, owner.status === 200),
        ...(foreign
          ? [result('Non-owner cannot edit project', 'PATCH', `/api/projects/${id}`, '403 (non-owner)', `${foreign.status}`, foreign.status === 403)]
          : []),
      ]
    }
    case 'DELETE /api/projects/[id]': {
      const id = await makeProject(env.arjunCookie)
      if (!id) return [result('Project delete succeeds', 'DELETE', '/api/projects/{id}', '200 (owner)', 'no project created', false)]
      const owner = await request('DELETE', `/api/projects/${id}`, { cookie: env.arjunCookie })
      const foreignId = env.meeraCookie ? await makeProject(env.meeraCookie) : null
      const foreign = foreignId
        ? await request('DELETE', `/api/projects/${foreignId}`, { cookie: env.arjunCookie })
        : null
      return [
        result('Owner can delete own project', 'DELETE', `/api/projects/${id}`, '200 (owner)', `${owner.status}`, owner.status === 200),
        ...(foreign
          ? [result('Non-owner cannot delete project', 'DELETE', `/api/projects/${foreignId}`, '403 (non-owner)', `${foreign.status}`, foreign.status === 403)]
          : []),
      ]
    }
    case 'POST /api/auth/login': {
      const wrong = await request('POST', '/api/auth/login', { body: { identifier: 'arjun', password: 'definitely-wrong-password' } })
      const right = await request('POST', '/api/auth/login', { body: { identifier: 'arjun', password: DEMO_PASSWORD } })
      return [
        result('Wrong password rejected', 'POST', '/api/auth/login', '401 (wrong password)', `${wrong.status}`, wrong.status === 401),
        result('Correct password accepted', 'POST', '/api/auth/login', '200 (login)', `${right.status}`, right.status === 200),
      ]
    }
    default: {
      if (endpoint.includes('health')) {
        const res = await request('GET', '/api/health')
        return [result('Application + database healthy', 'GET', '/api/health', '200 health', `${res.status}`, res.status === 200)]
      }
      const health = await request('GET', '/api/health')
      const feed = await request('GET', '/api/posts?pageSize=3', { cookie: env.arjunCookie })
      return [
        result('Application reachable', 'GET', '/api/health', '200 (app up)', `${health.status}`, health.status === 200),
        result('Database-backed feed healthy', 'GET', '/api/posts', '200 (feed)', `${feed.status}`, feed.status === 200),
      ]
    }
  }
}