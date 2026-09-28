#!/usr/bin/env node
/**
 * Local mock of the few Jira Cloud REST v3 endpoints BuildHub's approval
 * channel uses — for hermetic tests (never touches the real Jira site).
 *
 *   node scripts/mock-jira.mjs            (listens on MOCK_JIRA_PORT, default 3300)
 *
 * Project KAN with the board columns To Do / In Progress / In Review / Done.
 * Test controls (no auth): POST /__test/move {key,status}, POST /__test/comment
 * {key,text,author?}, GET /__test/issues, POST /__test/reset.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_JIRA_PORT ?? 3300)
const EMAIL = process.env.MOCK_JIRA_EMAIL ?? 'mock@example.com'
const TOKEN = process.env.MOCK_JIRA_TOKEN ?? 'mock-token'
const STATUSES = ['To Do', 'In Progress', 'In Review', 'Done']

let issues = new Map()
let seq = 0
let commentSeq = 0

const expectedAuth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function text(node) {
  if (!node || typeof node !== 'object') return ''
  return (node.text ?? '') + (Array.isArray(node.content) ? node.content.map(text).join(' ') : '')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const raw = await readBody(req)
  const json = () => (raw.length ? JSON.parse(raw.toString('utf8')) : {})

  // ---- test controls ------------------------------------------------------
  if (path === '/__test/issues') return send(res, 200, [...issues.values()].map((i) => ({ ...i, descriptionText: text(i.description) })))
  if (path === '/__test/reset') { issues = new Map(); seq = 0; return send(res, 200, { ok: true }) }
  if (path === '/__test/move') {
    const { key, status } = json()
    const issue = issues.get(key)
    if (!issue || !STATUSES.includes(status)) return send(res, 404, { errorMessages: ['no such issue/status'] })
    issue.status = status
    return send(res, 200, { ok: true })
  }
  if (path === '/__test/comment') {
    const { key, text: t, author } = json()
    const issue = issues.get(key)
    if (!issue) return send(res, 404, { errorMessages: ['no such issue'] })
    issue.comments.push({ id: String(++commentSeq), author: { displayName: author ?? 'Approver' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }, created: new Date().toISOString() })
    return send(res, 200, { ok: true })
  }

  // ---- Jira REST (Basic auth required, like the real API) ------------------
  if (req.headers.authorization !== expectedAuth) return send(res, 401, { errorMessages: ['Client must be authenticated to access this resource.'] })

  if (req.method === 'GET' && path === '/rest/api/3/myself') return send(res, 200, { accountId: 'mock-account', displayName: 'Mock Approver' })
  if (req.method === 'GET' && path === '/rest/api/3/project/KAN/statuses') {
    return send(res, 200, [{ name: 'Task', statuses: STATUSES.map((name) => ({ name })) }])
  }
  if (req.method === 'GET' && path === '/rest/api/3/mypermissions') {
    const wanted = (url.searchParams.get('permissions') ?? '').split(',').filter(Boolean)
    return send(res, 200, { permissions: Object.fromEntries(wanted.map((k) => [k, { key: k, havePermission: true }])) })
  }
  if (req.method === 'POST' && path === '/rest/api/3/issue') {
    const { fields } = json()
    if (fields?.project?.key !== 'KAN') return send(res, 400, { errors: { project: 'valid project is required' } })
    if (fields?.issuetype?.name !== 'Task') return send(res, 400, { errors: { issuetype: 'valid issue type is required' } })
    if (fields?.description?.type !== 'doc') return send(res, 400, { errors: { description: 'Operation value must be an Atlassian Document' } })
    const key = `KAN-${++seq}`
    issues.set(key, { key, summary: fields.summary, labels: fields.labels ?? [], description: fields.description, status: 'To Do', comments: [], attachments: [] })
    return send(res, 201, { id: String(seq), key, self: `http://localhost:${PORT}/rest/api/3/issue/${seq}` })
  }
  const m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)(\/(transitions|comment|attachments))?$/)
  const issue = m ? issues.get(decodeURIComponent(m[1])) : null
  if (m && !issue) return send(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] })
  if (m && !m[3] && req.method === 'GET') {
    return send(res, 200, { key: issue.key, fields: { status: { name: issue.status }, comment: { comments: issue.comments } } })
  }
  if (m?.[3] === 'transitions' && req.method === 'GET') {
    return send(res, 200, { transitions: STATUSES.filter((s) => s !== issue.status).map((s, i) => ({ id: String(11 + STATUSES.indexOf(s)), name: s, to: { name: s } })) })
  }
  if (m?.[3] === 'transitions' && req.method === 'POST') {
    const id = Number(json()?.transition?.id)
    const target = STATUSES[id - 11]
    if (!target) return send(res, 400, { errorMessages: ['invalid transition'] })
    issue.status = target
    return send(res, 204)
  }
  if (m?.[3] === 'comment' && req.method === 'POST') {
    const { body } = json()
    if (body?.type !== 'doc') return send(res, 400, { errors: { comment: 'Comment body must be ADF' } })
    issue.comments.push({ id: String(++commentSeq), author: { displayName: 'Mock Approver' }, body, created: new Date().toISOString() })
    return send(res, 201, { id: String(commentSeq) })
  }
  if (m?.[3] === 'attachments' && req.method === 'POST') {
    if (req.headers['x-atlassian-token'] !== 'no-check') return send(res, 403, { errorMessages: ['XSRF check failed'] })
    const name = (raw.toString('latin1').match(/filename="([^"]+)"/) ?? [])[1] ?? 'file'
    issue.attachments.push({ name, bytes: raw.length })
    return send(res, 200, [{ filename: name }])
  }
  return send(res, 404, { errorMessages: [`mock-jira: no route ${req.method} ${path}`] })
})

server.listen(PORT, () => console.log(`mock Jira on http://localhost:${PORT} (project KAN)`))
