'use client'

import Link from 'next/link'

import type { ComponentHealth, SummaryResponse } from '@/lib/api/observability'
import type { LearningResponse } from '@/lib/api/learning'
import type { SecurityStatusDTO } from '@/lib/api/security'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { Card, EmptyState, Pill } from './ui'

function statusStyle(status: ComponentHealth['status']) {
  if (status === 'healthy') return { label: 'Healthy', dot: 'bg-bh-success', text: 'text-bh-success' }
  if (status === 'degraded') return { label: 'Degraded', dot: 'bg-bh-warning', text: 'text-bh-warning' }
  return { label: 'Unavailable', dot: 'bg-bh-danger', text: 'text-bh-danger' }
}

export function SystemHealthRail({ summary }: { summary: SummaryResponse }) {
  const scores = [
    ['CYBER', summary.overview.cyberSafetyScore], ['RELIABILITY', summary.overview.applicationReliabilityScore],
    ['SYSTEM', summary.overview.systemHealth], ['TOTAL', summary.overview.totalHealthScore],
  ] as const
  return (
    <section className="grid gap-3 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]" aria-label="System health detail">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Control scores</p><h2 className="mt-1 text-sm font-semibold text-bh-ink">System health</h2></div>
          <span className="font-mono text-[10px] text-bh-faint">0—100</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-bh-line bg-bh-line sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {scores.map(([label, value]) => (
            <div key={label} className="bg-bh-bg/80 p-3">
              <p className={cn('font-mono text-xl font-semibold tabular-nums', value >= 90 ? 'text-bh-success' : value >= 65 ? 'text-bh-warning' : 'text-bh-danger')}>{value}</p>
              <p className="mt-1 text-[9px] font-medium tracking-wider text-bh-faint">{label}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Dependency posture</p><h2 className="mt-1 text-sm font-semibold text-bh-ink">Components</h2></div><span className="text-[10px] text-bh-faint">Live probes</span></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summary.components.map((component) => {
            const style = statusStyle(component.status)
            return <div key={component.name} className="min-w-0 rounded-lg border border-bh-line bg-bh-bg/45 p-3"><div className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', style.dot)} /><p className="min-w-0 flex-1 truncate text-xs font-medium text-bh-ink">{component.label}</p><span className={cn('text-[10px] font-medium', style.text)}>{style.label}</span></div><p className="mt-2 line-clamp-2 text-xs leading-[18px] text-bh-faint">{component.detail}</p></div>
          })}
        </div>
      </Card>
    </section>
  )
}

export function LearningSecurityEvidence({ learning, security }: { learning: LearningResponse | null; security: SecurityStatusDTO | null }) {
  const openSecurityIncidents = security?.incidents.filter((incident) => !['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED', 'REJECTED'].includes(incident.status)) ?? []
  const securityActive = (security?.overview.activeFindings ?? 0) > 0 || openSecurityIncidents.length > 0
  return (
    <section className="grid gap-4 lg:grid-cols-2" aria-label="Learning and security evidence">
      <Card className="overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-bh-line px-4 py-3"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">RL-ready repair memory</p><h2 className="mt-1 text-sm font-semibold text-bh-ink">Learning from outcomes</h2></div><Link href="/ai/learning" className="text-xs text-bh-accent-ink hover:underline">Open memory</Link></header>
        {learning ? (
          <div className="p-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                ['Experiences', learning.metrics.experienceCount], ['Successful', learning.metrics.successful],
                ['Failed', learning.metrics.failed], ['Rollbacks', learning.metrics.rolledBack],
                ['Avg reward', Number(learning.metrics.avgReward.toFixed(1))], ['Memories', learning.metrics.memoryCount],
              ].map(([label, value]) => <div key={label} className="rounded-lg border border-bh-line bg-bh-bg/45 p-3"><p className="font-mono text-lg font-semibold tabular-nums text-bh-ink">{value}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-bh-faint">{label}</p></div>)}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-bh-muted" aria-label="Learning relationship">
              {['ERROR', 'REPAIR', 'OUTCOME', 'REWARD', 'MEMORY', 'FUTURE DECISION'].map((label, index) => <span key={label} className="flex items-center gap-1.5"><span className="rounded border border-bh-line bg-bh-bg px-2 py-1">{label}</span>{index < 5 && <span className="text-bh-faint">→</span>}</span>)}
            </div>
            <p className="mt-4 border-t border-bh-line pt-3 text-[11px] leading-5 text-bh-faint">Learning stores repair experiences and rewards for future decisions. It does not claim or imply that model weights were trained.</p>
          </div>
        ) : <EmptyState icon="sparkles" title="Learning data unavailable" message="Repair memory remains in the database; this summary could not be loaded." />}
      </Card>

      <Card className="overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-bh-line px-4 py-3"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Separate operational state</p><h2 className="mt-1 text-sm font-semibold text-bh-ink">Security detection</h2></div><Link href="/ai/security" className="text-xs text-bh-accent-ink hover:underline">Open security</Link></header>
        {security ? (
          <div className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={securityActive ? 'danger' : 'success'}>{openSecurityIncidents.length > 0 ? `${openSecurityIncidents.length} OPEN SECURITY INCIDENT${openSecurityIncidents.length === 1 ? '' : 'S'}` : security.overview.activeFindings > 0 ? `${security.overview.activeFindings} ACTIVE FINDINGS` : 'NORMAL'}</Pill>
              <Pill tone={security.tier === 'critical' || security.tier === 'heightened' ? 'warning' : 'neutral'}>{security.tier.toUpperCase()}</Pill>
              <span className="ml-auto font-mono text-[10px] text-bh-faint">Cyber {security.overview.cyberSafetyScore}/100</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-1.5 text-center font-mono text-[9px] sm:grid-cols-6">
              {['NORMAL', 'SIGNAL DETECTED', 'INCIDENT', 'AI ANALYSIS', 'MITIGATION', 'AVAILABLE'].map((step, index) => {
                const hasIncident = openSecurityIncidents.length > 0
                const hasAnalysis = security.incidents.some((incident) => incident.agentRuns.some((run) => run.status === 'COMPLETE'))
                const mitigated = security.incidents.some((incident) => incident.status === 'RESOLVED')
                const activeIndex = !securityActive ? 0 : mitigated ? 5 : hasAnalysis ? 3 : hasIncident ? 2 : 1
                const proven = index <= activeIndex || (index === 5 && security.overview.systemHealth > 0)
                return <div key={step} className={cn('rounded border px-1 py-2', proven ? 'border-bh-accent/35 bg-bh-accent-soft text-bh-accent-ink' : 'border-bh-line bg-bh-bg/45 text-bh-faint')}>{step}</div>
              })}
            </div>
            {security.findings.length ? <ul className="mt-4 space-y-2">{security.findings.slice(0, 3).map((finding) => <li key={finding.id} className="flex min-w-0 items-start gap-2 rounded-lg border border-bh-line bg-bh-bg/45 p-3"><Icon name="shield" size={14} className="mt-0.5 shrink-0 text-bh-warning" /><div className="min-w-0"><p className="truncate text-xs font-medium text-bh-ink">{finding.title}</p><p className="mt-1 line-clamp-2 text-xs leading-[18px] text-bh-faint">{finding.detail ?? `${finding.ruleId} · ${finding.hitCount} hits`}</p></div></li>)}</ul> : <p className="mt-4 rounded-lg border border-bh-success/20 bg-bh-success/5 p-3 text-xs leading-[18px] text-bh-muted">{openSecurityIncidents.length > 0 ? `No active findings; ${openSecurityIncidents.length} security incident${openSecurityIncidents.length === 1 ? '' : 's'} remain open.` : 'No database-backed security findings are active. The service remains available and monitored.'}</p>}
          </div>
        ) : <EmptyState icon="shield" title="Security data unavailable" message="The security summary could not be loaded. Open Security for persisted status." />}
      </Card>
    </section>
  )
}
