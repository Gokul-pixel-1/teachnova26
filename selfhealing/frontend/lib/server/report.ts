import 'server-only'

import PDFDocument from 'pdfkit'
import type { IncidentDetailDTO, Overview } from './observability'
import type { IncidentBrief } from './notifications/brief'

const NAVY = '#102238'
const BLUE = '#2563eb'
const INK = '#172033'
const MUTED = '#66758a'
const LINE = '#d9e1ea'
const PALE = '#f4f7fa'
const GREEN = '#15803d'
const AMBER = '#b45309'
const RED = '#b91c1c'
const LEFT = 48
const RIGHT = 547
const WIDTH = RIGHT - LEFT
const BOTTOM = 770

export interface DeliveryInfo {
  id: string
  type: string
  severity: string | null
  deliveryStatus: string
  externalMessageId: string | null
  error: string | null
  createdAt: string
}

export interface SecurityEvidenceInfo {
  ruleId: string
  title: string
  detail: string | null
  hitCount: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface ReportInput {
  detail: IncidentDetailDTO
  overview: Overview
  generatedAt: string
  brief: IncidentBrief | null
  telegram: DeliveryInfo[]
  gmail: DeliveryInfo[]
  securityEvidence: SecurityEvidenceInfo[]
}

function clean(value: unknown, fallback = 'Not recorded'): string {
  if (typeof value === 'string') {
    const text = value
      .replace(/<[^>]+>/g, '')
      .replace(/\b(?:LOW|MEDIUM|HIGH|COMMENT)-\d{1,2}\b\s*(?:INTENTIONAL\s+RUNTIME\s+ERROR|CREATED)?/gi, 'controlled incident')
      .replace(/\b(?:intentional|demo)\s+(?:runtime\s+)?fault\b/gi, 'controlled incident')
      .replace(/\bfault\s+fixture\b/gi, 'controlled incident')
      .replace(/→/g, '->').replace(/←/g, '<-').replace(/[–—]/g, '-').replace(/·/g, ' | ')
      .replace(/[✓✔✅]/g, 'PASS').replace(/[✗✕❌]/g, 'FAIL').replace(/[•●]/g, '-')
      .normalize('NFKD').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim()
    return text || fallback
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function timestamp(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? clean(value) : date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

function tone(value: string): string {
  const text = value.toUpperCase()
  if (/FAIL|REJECT|ROLLBACK|HIGH|CRITICAL/.test(text)) return RED
  if (/WAIT|PENDING|MEDIUM|WARN/.test(text)) return AMBER
  if (/PASS|SENT|RESOLVED|APPROVED|CONSUMED|LOW/.test(text)) return GREEN
  return BLUE
}

export function generateIncidentReport(input: ReportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { detail, overview, brief } = input
    const doc = new PDFDocument({
      size: 'A4', margin: LEFT, bufferPages: true,
      info: { Title: `BuildHub Incident Report ${detail.ref}`, Author: 'BuildHub Self-Healing Operations', Subject: detail.title, Creator: 'BuildHub Incident Reporting' },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const ensure = (height: number) => { if (doc.y + height > BOTTOM) doc.addPage() }
    const rule = () => doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(LINE).lineWidth(0.7).stroke()
    const section = (title: string, subtitle?: string) => {
      ensure(subtitle ? 58 : 43)
      doc.moveDown(0.85).font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(title)
      if (subtitle) doc.moveDown(0.12).font('Helvetica').fontSize(8).fillColor(MUTED).text(clean(subtitle))
      doc.moveDown(0.35); rule(); doc.moveDown(0.55)
    }
    const paragraph = (value: unknown) => {
      ensure(32); doc.font('Helvetica').fontSize(9).fillColor(INK).text(clean(value), { lineGap: 2 }); doc.moveDown(0.35)
    }
    const field = (label: string, value: unknown) => {
      const raw = clean(value)
      const safe = raw.length > 1800 ? `${raw.slice(0, 1797)}...` : raw
      const height = Math.max(22, doc.heightOfString(safe, { width: 354, lineGap: 1 }) + 8)
      ensure(height)
      const y = doc.y
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), LEFT, y + 2, { width: 128 })
      doc.font('Helvetica').fontSize(8.8).fillColor(INK).text(safe, LEFT + 138, y, { width: 361, lineGap: 1 })
      doc.y = Math.max(doc.y, y + height)
    }
    const badge = (label: string, value: string) => {
      ensure(26); const y = doc.y
      doc.roundedRect(LEFT, y, WIDTH, 22, 4).fill(PALE)
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), LEFT + 9, y + 7, { width: 120 })
      doc.fillColor(tone(value)).text(clean(value), LEFT + 138, y + 7, { width: 350 }); doc.y = y + 28
    }
    const code = (label: string, value: unknown) => {
      section(label); ensure(55); const safe = clean(value)
      const height = Math.min(215, Math.max(46, doc.heightOfString(safe, { width: 471, lineGap: 2 }) + 20))
      const y = doc.y
      doc.roundedRect(LEFT, y, WIDTH, height, 5).fill(NAVY)
      doc.font('Courier').fontSize(7.4).fillColor('#e6edf5').text(safe, LEFT + 12, y + 10, { width: 475, height: height - 18, ellipsis: true, lineGap: 2 })
      doc.y = y + height + 3
    }
    const timelineItem = (index: number, label: string, at: string | null | undefined, value: unknown, state = '') => {
      const raw = clean(value)
      const safe = raw.length > 1600 ? `${raw.slice(0, 1597)}...` : raw
      const estimated = Math.max(42, doc.heightOfString(safe, { width: 471, lineGap: 1 }) + 26)
      ensure(estimated); const y = doc.y
      doc.circle(LEFT + 8, y + 8, 8).fill(state ? tone(state) : BLUE)
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff').text(String(index), LEFT + 4, y + 5, { width: 8, align: 'center' })
      doc.font('Helvetica-Bold').fontSize(8.7).fillColor(INK).text(label, LEFT + 28, y, { width: 250 })
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(timestamp(at), LEFT + 300, y + 1, { width: 199, align: 'right' })
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(safe, LEFT + 28, y + 15, { width: 471, lineGap: 1 })
      doc.y = Math.max(doc.y, y + estimated)
    }

    doc.rect(LEFT, LEFT, WIDTH, 6).fill(BLUE); doc.y = 70
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BLUE).text('BUILDHUB · AI SELF-HEALING OPERATIONS', { characterSpacing: 1.2 })
    doc.moveDown(0.35).font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('INCIDENT REPORT')
    doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor(MUTED).text(`${detail.ref} · generated ${timestamp(input.generatedAt)}`)
    doc.moveDown(0.85); badge('Final incident status', detail.status)
    field('Incident ID', detail.ref)
    field('Severity / risk', `${detail.severity} / ${brief?.risk.tier ?? detail.severity} · score ${detail.riskScore}/100`)
    field('Endpoint / request', `${detail.method} ${detail.endpoint}${detail.requestId ? ` · ${detail.requestId}` : ''}`)
    field('Detected', timestamp(detail.createdAt)); field('What happened', detail.summary ?? detail.description)

    section('1. Technical diagnosis', 'Persisted incident, AgentRun, patch, and validation facts')
    field('Root cause', brief?.rootCause ?? detail.expectedRootCause); field('File', brief?.location?.file ?? brief?.patch?.file)
    field('Line', brief?.location?.line); field('Function', brief?.location?.function)
    field('Detection evidence', brief?.history?.logExcerpt ?? detail.logs[0]?.message)

    section('2. Agent summaries')
    const analyzer = detail.agentRuns.filter((run) => (run.kind ?? run.agent) === 'ANALYZER').at(-1)
    field('Analyzer', analyzer?.outputSummary ?? analyzer?.currentActivity)
    const rounds = brief?.aiAnalysis.rounds ?? []
    if (rounds.length === 0) paragraph('No persisted Coder/Critic conversation was recorded for this incident.')
    for (const round of rounds) {
      field(`Coder · round ${round.round}`, round.coder.diagnosis ?? round.coder.status)
      field(`Critic · round ${round.round}`, `${round.critic.verdict ?? 'Not recorded'} · ${round.critic.reasoning ?? 'No structured review summary recorded.'}`)
    }
    field('Judge decision', brief?.aiAnalysis.judge ? `${brief.aiAnalysis.judge.decision ?? 'Not recorded'} · ${brief.aiAnalysis.judge.reasoning ?? ''}` : null)
    field('Risk classification', `${brief?.risk.tier ?? detail.severity} · ${brief?.risk.reason ?? 'No additional reason recorded.'}`)

    code('3. Proposed change · BEFORE', brief?.codeChange?.before); code('4. Proposed change · AFTER', brief?.codeChange?.after)
    field('Change summary', brief?.proposedFix)

    section('5. Validation, rollback, and human control')
    field('Validation plan', brief?.validationPlan)
    field('Validation result', `${brief?.validation.result ?? detail.terminalSummary?.validation.result ?? 'not_run'} · ${brief?.validation.detail ?? detail.terminalSummary?.validation.detail ?? 'No detail recorded.'}`)
    field('Probes', brief?.validation.probes.length ? brief.validation.probes.map((probe) => `${probe.ok ? 'PASS' : 'FAIL'} ${probe.name}`).join('\n') : null)
    field('Human decision', brief?.approval ? `${brief.approval.status} · ${brief.approval.operator ?? 'operator not recorded'} · ${timestamp(brief.approval.createdAt)}` : null)
    field('Rollback result', brief?.patch?.rolledBackAt ? `Rolled back at ${timestamp(brief.patch.rolledBackAt)}; original content restored.` : detail.status === 'ROLLED_BACK' ? 'Rollback recorded.' : 'Rollback not required.')

    section('6. Complete chronological timeline', brief?.attack ? 'Security sequence is expanded in the next section.' : 'Operational sequence from detection through learning')
    const eventFor = (pattern: RegExp) => detail.timeline.find((event) => pattern.test(`${event.stage} ${event.label}`))
    const runFor = (kind: string) => detail.agentRuns.filter((run) => (run.kind ?? run.agent) === kind).at(-1)
    const approval = detail.approvals[0]
    const gmail = input.gmail.find((row) => /APPROVAL/.test(row.type)) ?? input.gmail[0]
    const telegram = input.telegram.find((row) => row.type === 'FINAL_SUMMARY') ?? input.telegram[0]
    const standard: Array<[string, string | null | undefined, unknown, string]> = [
      ['Incident detected', detail.createdAt, detail.description, detail.status],
      ['Evidence / log captured', detail.logs.at(-1)?.createdAt, brief?.history?.logExcerpt ?? detail.logs.at(-1)?.message, detail.logs.length ? 'complete' : ''],
      ['Analyzer result', runFor('ANALYZER')?.completedAt ?? runFor('ANALYZER')?.createdAt, runFor('ANALYZER')?.outputSummary, runFor('ANALYZER')?.status ?? ''],
      ['Coder proposal', runFor('CODER')?.completedAt ?? runFor('CODER')?.createdAt, runFor('CODER')?.outputSummary ?? brief?.proposedFix, runFor('CODER')?.status ?? ''],
      ['Critic review', runFor('CRITIC')?.completedAt ?? runFor('CRITIC')?.createdAt, runFor('CRITIC')?.outputSummary ?? rounds.at(-1)?.critic.reasoning, runFor('CRITIC')?.status ?? ''],
      ['Judge decision', runFor('JUDGE')?.completedAt ?? runFor('JUDGE')?.createdAt, runFor('JUDGE')?.outputSummary ?? brief?.aiAnalysis.judge?.reasoning, runFor('JUDGE')?.status ?? ''],
      ['Risk classification', detail.repairAttempt?.startedAt, `${brief?.risk.tier ?? detail.severity} · ${brief?.risk.reason ?? 'Persisted incident severity policy'}`, brief?.risk.tier ?? detail.severity],
      ['Gmail approval request sent', gmail?.createdAt, gmail ? `${gmail.deliveryStatus} · ${gmail.type}${gmail.externalMessageId ? ` · message ${gmail.externalMessageId}` : ''}` : null, gmail?.deliveryStatus ?? ''],
      ['Human APPROVE / REJECT', approval?.statusUpdatedAt ?? approval?.createdAt, approval ? `${approval.status} · ${approval.reviewer}` : null, approval?.status ?? ''],
      ['Patch applied', brief?.patch?.appliedAt ?? detail.patch?.createdAt, brief?.patch ? `${brief.patch.status} · ${brief.patch.patchId}` : null, brief?.patch?.status ?? ''],
      ['Validation started', eventFor(/VALIDAT/i)?.at, eventFor(/VALIDAT/i)?.detail ?? 'Validation begins after patch application.', eventFor(/VALIDAT/i)?.stage ?? ''],
      ['Validation result', brief?.validation.validatedAt ?? detail.patch?.validatedAt, `${brief?.validation.result ?? 'not_run'} · ${brief?.validation.detail ?? 'No detail recorded.'}`, brief?.validation.result ?? ''],
      ['Recovery or rollback', detail.resolvedAt ?? brief?.patch?.rolledBackAt, detail.terminalSummary?.text ?? detail.status, detail.status],
      ['Telegram notification', telegram?.createdAt, telegram ? `${telegram.deliveryStatus} · ${telegram.type}${telegram.externalMessageId ? ` · message ${telegram.externalMessageId}` : ''}` : null, telegram?.deliveryStatus ?? ''],
      ['Final incident status', detail.updatedAt, detail.status, detail.status],
      ['Learning / repair-memory record', detail.learning?.updatedAt, detail.learning ? `${detail.learning.outcome} · reward ${detail.learning.reward} · recurrence ${detail.learning.recurrenceCount}` : null, detail.learning?.outcome ?? ''],
    ]
    standard.forEach((row, index) => timelineItem(index + 1, ...row))

    if (brief?.attack) {
      section('7. Security incident record', 'ATTACK → DETECTION → ANALYSIS → RISK → MITIGATION → SERVICE RESPONSE → NOTIFICATION → FINAL RESULT')
      const finding = input.securityEvidence[0]
      const blocked = detail.logs.filter((log) => log.errorCode === 'IP_BLOCKED')
      const failed = detail.logs.filter((log) => log.errorCode === 'AUTH_FAILED')
      const securityTimeline: Array<[string, string | null | undefined, unknown, string]> = [
        ['ATTACK', failed.at(-1)?.createdAt ?? finding?.firstSeenAt, finding?.detail ?? detail.description, 'HIGH'],
        ['DETECTION', detail.createdAt, `${finding?.hitCount ?? failed.length} suspicious requests · ${finding?.ruleId ?? detail.errorCode ?? 'security signal'}`, detail.severity],
        ['ANALYSIS', runFor('FIXER')?.completedAt, runFor('FIXER')?.outputSummary ?? detail.summary, runFor('FIXER')?.status ?? ''],
        ['RISK', detail.createdAt, `${detail.severity} · risk score ${detail.riskScore}/100`, detail.severity],
        ['MITIGATION', blocked.at(-1)?.createdAt ?? finding?.lastSeenAt, blocked.length ? `${blocked.length} request(s) rejected by the temporary source-IP block / rate limit.` : finding?.detail, blocked.length || finding?.detail ? 'complete' : ''],
        ['SERVICE RESPONSE', detail.updatedAt, `Health ${overview.systemHealth}% · reliability ${overview.applicationReliabilityScore}% · cyber safety ${overview.cyberSafetyScore}%`, overview.systemHealth >= 65 ? 'complete' : 'failed'],
        ['NOTIFICATION', gmail?.createdAt ?? telegram?.createdAt, `Gmail ${gmail?.deliveryStatus ?? 'not recorded'} · Telegram ${telegram?.deliveryStatus ?? 'not recorded'}`, gmail?.deliveryStatus ?? telegram?.deliveryStatus ?? ''],
        ['FINAL RESULT', detail.resolvedAt ?? detail.updatedAt, detail.terminalSummary?.text ?? detail.status, detail.status],
      ]
      securityTimeline.forEach((row, index) => timelineItem(index + 1, ...row))
      field('Service health before / after', `Detection risk ${detail.riskScore}/100 · current system health ${overview.systemHealth}% · total health ${overview.totalHealthScore}%`)
    }

    section(brief?.attack ? '8. Notification delivery audit' : '7. Notification delivery audit')
    for (const [channel, rows] of [['Gmail', input.gmail], ['Telegram', input.telegram]] as const) {
      if (rows.length === 0) field(channel, 'No delivery record persisted.')
      for (const row of rows) field(channel, `${row.deliveryStatus} · ${row.type} · ${timestamp(row.createdAt)}${row.externalMessageId ? ` · message ${row.externalMessageId}` : ''}${row.error ? ` · ${row.error}` : ''}`)
    }

    section(brief?.attack ? '9. Final outcome and learning' : '8. Final outcome and learning')
    badge('Outcome', detail.status); field('Final outcome', detail.terminalSummary?.text ?? detail.summary ?? detail.status)
    field('Repair memory', detail.learning ? `${detail.learning.outcome} · reward ${detail.learning.reward} · risk ${detail.learning.risk ?? 'Not recorded'} · human ${detail.learning.humanDecision ?? 'Not recorded'}` : null)
    field('Reward breakdown', detail.learning?.rewardBreakdown ? Object.entries(detail.learning.rewardBreakdown).map(([key, value]) => `${key}: ${value}`).join(' · ') : null)

    const range = doc.bufferedPageRange()
    for (let page = range.start; page < range.start + range.count; page += 1) {
      doc.switchToPage(page)
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`BuildHub | persisted incident evidence | ${detail.ref}`, LEFT, 782, { width: 390, lineBreak: false })
      doc.text(`Page ${page - range.start + 1} of ${range.count}`, 438, 782, { width: 109, align: 'right', lineBreak: false })
    }
    doc.end()
  })
}
