#!/usr/bin/env node
/**
 * One-time Jira setup for BuildHub's approval channel.
 *
 *   node scripts/jira-setup.mjs
 *
 * Asks (locally, in this terminal) for your Atlassian email and API token —
 * the token is typed hidden and is never printed. It then checks the
 * connection, the KAN project, its board statuses and your permissions, and
 * writes JIRA_* settings into .env.local (replacing old JIRA_* lines).
 * Restart BuildHub afterwards so it picks them up.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = resolve(ROOT, '.env.local')
const DEFAULTS = {
  JIRA_BASE_URL: 'https://gokulsenthilganesh1.atlassian.net',
  JIRA_EMAIL: 'gokulsenthilganesh1@gmail.com',
  JIRA_PROJECT_KEY: 'KAN',
  JIRA_ISSUE_TYPE: 'Task',
  JIRA_WAITING_STATUS: 'In Review',
  JIRA_APPROVE_STATUS: 'Done',
  JIRA_REJECT_STATUS: 'To Do',
}

// One line reader for every prompt (typed or piped). While a hidden prompt
// is active, the terminal echo is swallowed and a "*" is shown instead.
let muted = false
const echo = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk)
    else process.stdout.write('*'.repeat([...chunk.toString()].filter((c) => c >= ' ').length))
    cb()
  },
})
const rl = createInterface({ input: process.stdin, output: echo, terminal: Boolean(process.stdin.isTTY) })
const lines = rl[Symbol.asyncIterator]()

async function readLine() {
  const next = await lines.next()
  return next.done ? '' : next.value
}

async function ask(question, fallback) {
  process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}: `)
  const answer = (await readLine()).trim()
  if (!process.stdin.isTTY) process.stdout.write('\n')
  return answer || fallback || ''
}

async function askHidden(question) {
  process.stdout.write(`${question}: `)
  muted = true
  const answer = (await readLine()).trim()
  muted = false
  process.stdout.write('\n')
  return answer
}

async function jira(cfg, path) {
  const res = await fetch(`${cfg.JIRA_BASE_URL}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.JIRA_EMAIL}:${cfg.JIRA_API_TOKEN}`).toString('base64')}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}

async function main() {
  console.log('BuildHub → Jira approval setup\n')
  console.log('You need an Atlassian API token. Create one at:')
  console.log('  https://id.atlassian.com/manage-profile/security/api-tokens  ("Create API token")\n')
  const cfg = { ...DEFAULTS }
  cfg.JIRA_BASE_URL = (await ask('Jira site', DEFAULTS.JIRA_BASE_URL)).replace(/\/+$/, '')
  cfg.JIRA_EMAIL = await ask('Atlassian account email', DEFAULTS.JIRA_EMAIL)
  cfg.JIRA_API_TOKEN = await askHidden('API token (hidden, paste then Enter)')
  if (!cfg.JIRA_API_TOKEN) { console.error('No token entered — nothing changed.'); process.exit(1) }
  cfg.JIRA_PROJECT_KEY = (await ask('Project key', DEFAULTS.JIRA_PROJECT_KEY)).toUpperCase()

  console.log('\nChecking…')
  const me = await jira(cfg, '/rest/api/3/myself')
  if (me.status !== 200) {
    console.error(`✗ Could not log in to Jira (HTTP ${me.status}). Check the site, email and token — nothing was saved.`)
    process.exit(1)
  }
  console.log(`✓ Logged in as ${me.json?.displayName}`)

  const st = await jira(cfg, `/rest/api/3/project/${cfg.JIRA_PROJECT_KEY}/statuses`)
  if (st.status !== 200) {
    console.error(`✗ Project ${cfg.JIRA_PROJECT_KEY} not found or not visible (HTTP ${st.status}) — nothing was saved.`)
    process.exit(1)
  }
  const types = (st.json ?? []).map((t) => t.name)
  const statuses = [...new Set((st.json ?? []).flatMap((t) => (t.statuses ?? []).map((s) => s.name)))]
  console.log(`✓ Project ${cfg.JIRA_PROJECT_KEY}: issue types ${types.join(', ')}; statuses ${statuses.join(', ')}`)
  if (!types.includes(cfg.JIRA_ISSUE_TYPE)) {
    cfg.JIRA_ISSUE_TYPE = types.find((t) => /task/i.test(t)) ?? types[0] ?? 'Task'
    console.log(`  → using issue type "${cfg.JIRA_ISSUE_TYPE}"`)
  }
  const find = (want) => statuses.find((s) => s.toLowerCase() === want.toLowerCase())
  for (const [key, want] of [['JIRA_WAITING_STATUS', 'In Review'], ['JIRA_APPROVE_STATUS', 'Done'], ['JIRA_REJECT_STATUS', 'To Do']]) {
    const hit = find(want)
    if (hit) cfg[key] = hit
    else console.log(`  ! status "${want}" not on this board — ${key} kept as "${cfg[key]}"; change it in .env.local if needed`)
  }

  const perms = await jira(cfg, `/rest/api/3/mypermissions?projectKey=${cfg.JIRA_PROJECT_KEY}&permissions=CREATE_ISSUES,TRANSITION_ISSUES,ADD_COMMENTS,CREATE_ATTACHMENTS,BROWSE_PROJECTS`)
  const missing = Object.entries(perms.json?.permissions ?? {}).filter(([, v]) => !v.havePermission).map(([k]) => k)
  if (missing.length) console.log(`  ! missing Jira permissions: ${missing.join(', ')}`)
  else console.log('✓ Permissions: create, move, comment, attach')

  const keys = [...Object.keys(DEFAULTS), 'JIRA_API_TOKEN', 'APPROVAL_CHANNEL', 'JIRA_APPROVAL_TTL_MINUTES', 'JIRA_POLL_SECONDS']
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : []
  const kept = existing.filter((l) => !keys.some((k) => l.startsWith(`${k}=`)) && !/^# Jira approval channel/.test(l))
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  const lines = [
    ...kept,
    '',
    '# Jira approval channel (written by scripts/jira-setup.mjs)',
    ...Object.keys(DEFAULTS).map((k) => `${k}=${cfg[k]}`),
    `JIRA_API_TOKEN=${cfg.JIRA_API_TOKEN}`,
    'APPROVAL_CHANNEL=jira',
    'JIRA_APPROVAL_TTL_MINUTES=30',
    'JIRA_POLL_SECONDS=15',
    '',
  ]
  writeFileSync(ENV_FILE, lines.join('\n'), 'utf8')
  console.log(`\n✓ Saved to .env.local (token stored there only). Restart BuildHub to use Jira approvals.`)
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
