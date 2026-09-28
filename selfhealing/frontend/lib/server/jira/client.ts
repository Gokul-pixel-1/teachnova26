import 'server-only'

// Minimal Jira Cloud REST v3 client for the approval channel.
//
// Credentials come only from the environment (JIRA_EMAIL + JIRA_API_TOKEN,
// Basic auth) and are never logged or returned by any API. In TEST mode the
// client refuses any non-localhost JIRA_BASE_URL, so hermetic test runs can
// only ever talk to scripts/mock-jira.mjs — never the real Jira site.

export interface JiraConfig {
  baseUrl: string
  email: string
  token: string
  projectKey: string
  issueType: string
  /** Status the card is created in / moved to while waiting for a decision. */
  waitingStatus: string
  /** Moving the card to this status approves. */
  approveStatus: string
  /** Moving the card to this status rejects. */
  rejectStatus: string
}

export type JiraConfigResult = { ok: true; config: JiraConfig } | { ok: false; reason: string }

const env = (name: string, fallback = '') => (process.env[name] ?? '').trim() || fallback

function testMode(): boolean {
  return (process.env.SELF_HEALING_TEST_MODE ?? '').trim().toLowerCase() === 'true'
}

export function jiraConfig(): JiraConfigResult {
  const baseUrl = env('JIRA_BASE_URL').replace(/\/+$/, '')
  const email = env('JIRA_EMAIL')
  const token = env('JIRA_API_TOKEN')
  const missing = [!baseUrl && 'JIRA_BASE_URL', !email && 'JIRA_EMAIL', !token && 'JIRA_API_TOKEN'].filter(Boolean)
  if (missing.length > 0) return { ok: false, reason: `Jira is not configured (missing ${missing.join(', ')}).` }
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return { ok: false, reason: 'JIRA_BASE_URL is not a valid URL.' }
  }
  if (testMode() && host !== 'localhost' && host !== '127.0.0.1') {
    return { ok: false, reason: 'TEST mode only talks to a local mock Jira (JIRA_BASE_URL must be localhost).' }
  }
  return {
    ok: true,
    config: {
      baseUrl,
      email,
      token,
      projectKey: env('JIRA_PROJECT_KEY', 'KAN'),
      issueType: env('JIRA_ISSUE_TYPE', 'Task'),
      waitingStatus: env('JIRA_WAITING_STATUS', 'In Review'),
      approveStatus: env('JIRA_APPROVE_STATUS', 'Done'),
      rejectStatus: env('JIRA_REJECT_STATUS', 'To Do'),
    },
  }
}

/** Which channel asks humans for approval: 'jira' when APPROVAL_CHANNEL=jira
 * (the default once Jira credentials exist), otherwise the original email. */
export function approvalChannel(): 'jira' | 'email' {
  const wanted = env('APPROVAL_CHANNEL').toLowerCase()
  if (wanted === 'email') return 'email'
  return jiraConfig().ok ? 'jira' : 'email'
}

/** How long a Jira approval stays open (JIRA_APPROVAL_TTL_MINUTES, default 30). */
export function jiraApprovalTtlMs(): number {
  const minutes = Number.parseInt(env('JIRA_APPROVAL_TTL_MINUTES'), 10)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60 * 1000
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function jira<T>(
  cfg: JiraConfig,
  method: string,
  path: string,
  body?: unknown,
  init: { form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`,
    Accept: 'application/json',
  }
  if (init.form) headers['X-Atlassian-Token'] = 'no-check'
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers,
    body: init.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  })
  const text = await res.text()
  if (!res.ok) {
    // Jira error bodies carry field messages, never our credentials.
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> }
      detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ') || detail
    } catch {
      /* keep raw */
    }
    throw new JiraError(`Jira ${method} ${path.split('?')[0]} → ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
  }
  return (text ? JSON.parse(text) : null) as T
}

// ---------------------------------------------------------------------------
// Atlassian Document Format (issue descriptions and comments are ADF in v3)

export type AdfNode = Record<string, unknown>

export const adf = {
  doc: (content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content }),
  p: (...parts: Array<string | AdfNode>): AdfNode => ({
    type: 'paragraph',
    content: parts.filter((x) => x !== '').map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x)),
  }),
  text: (text: string, marks: Array<'strong' | 'code'> = []): AdfNode =>
    marks.length ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text },
  link: (text: string, href: string): AdfNode => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }),
  h: (level: number, text: string): AdfNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }),
  code: (text: string, language = 'tsx'): AdfNode => ({
    type: 'codeBlock',
    attrs: { language },
    content: text ? [{ type: 'text', text: text.slice(0, 6000) }] : [],
  }),
  bullets: (items: string[]): AdfNode => ({
    type: 'bulletList',
    content: items.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t || '-' }] }] })),
  }),
  panel: (panelType: 'info' | 'note' | 'success' | 'warning' | 'error', content: AdfNode[]): AdfNode => ({
    type: 'panel',
    attrs: { panelType },
    content,
  }),
  rule: (): AdfNode => ({ type: 'rule' }),
}

/** Plain text from an ADF comment body (for "approve"/"reject" detection). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: string; content?: unknown[] }
  return (n.text ?? '') + (Array.isArray(n.content) ? n.content.map(adfToText).join(' ') : '')
}

// ---------------------------------------------------------------------------
// Operations

export interface JiraIssueState {
  key: string
  status: string
  comments: Array<{ id: string; author: string; text: string; created: string }>
}

export function issueUrl(cfg: JiraConfig, key: string): string {
  return `${cfg.baseUrl}/browse/${key}`
}

export async function jiraMyself(cfg: JiraConfig): Promise<{ accountId: string; displayName: string }> {
  return jira(cfg, 'GET', '/rest/api/3/myself')
}

export async function createIssue(
  cfg: JiraConfig,
  args: { summary: string; description: AdfNode; labels: string[] },
): Promise<{ key: string; url: string }> {
  const fields = {
    project: { key: cfg.projectKey },
    issuetype: { name: cfg.issueType },
    summary: args.summary.slice(0, 250),
    description: args.description,
    labels: args.labels,
  }
  let created: { key: string }
  try {
    created = await jira<{ key: string }>(cfg, 'POST', '/rest/api/3/issue', { fields })
  } catch (err) {
    // A project whose screens do not allow labels still gets the issue.
    if (err instanceof JiraError && err.status === 400 && /labels/i.test(err.message)) {
      const { labels: _unused, ...rest } = fields
      void _unused
      created = await jira<{ key: string }>(cfg, 'POST', '/rest/api/3/issue', { fields: rest })
    } else {
      throw err
    }
  }
  return { key: created.key, url: issueUrl(cfg, created.key) }
}

export async function getIssueState(cfg: JiraConfig, key: string): Promise<JiraIssueState> {
  const issue = await jira<{
    key: string
    fields: {
      status?: { name?: string }
      comment?: { comments?: Array<{ id: string; author?: { displayName?: string }; body?: unknown; created?: string }> }
    }
  }>(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,comment`)
  return {
    key: issue.key,
    status: issue.fields.status?.name ?? '',
    comments: (issue.fields.comment?.comments ?? []).map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? 'someone',
      text: adfToText(c.body).trim(),
      created: c.created ?? '',
    })),
  }
}

/** Moves the issue to the named status via whichever transition reaches it.
 * Returns false (never throws) when the workflow has no such transition. */
export async function transitionTo(cfg: JiraConfig, key: string, statusName: string): Promise<boolean> {
  try {
    const { transitions } = await jira<{ transitions: Array<{ id: string; name: string; to?: { name?: string } }> }>(
      cfg,
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    )
    const want = statusName.trim().toLowerCase()
    const t =
      transitions.find((x) => (x.to?.name ?? '').toLowerCase() === want) ??
      transitions.find((x) => x.name.toLowerCase() === want)
    if (!t) return false
    await jira(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } })
    return true
  } catch {
    return false
  }
}

export async function addComment(cfg: JiraConfig, key: string, body: AdfNode): Promise<void> {
  await jira(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body })
}

export async function attachFile(cfg: JiraConfig, key: string, name: string, bytes: Buffer, type = 'image/png'): Promise<void> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name)
  await jira(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, undefined, { form })
}

/** Names of the statuses the project's workflow offers (for setup checks). */
export async function projectStatuses(cfg: JiraConfig): Promise<string[]> {
  const rows = await jira<Array<{ name: string; statuses?: Array<{ name: string }> }>>(
    cfg,
    'GET',
    `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}/statuses`,
  )
  return [...new Set(rows.flatMap((r) => (r.statuses ?? []).map((s) => s.name)))]
}

export async function projectIssueTypes(cfg: JiraConfig): Promise<string[]> {
  const rows = await jira<Array<{ name: string }>>(
    cfg,
    'GET',
    `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}/statuses`,
  )
  return rows.map((r) => r.name)
}
