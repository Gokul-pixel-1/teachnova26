import 'server-only'

// Phase 9 — deterministic patch-risk classification (no AI involvement, no
// randomness). Risk is decided ONLY from structural evidence: the incident
// record and the candidate's target file. It grades the blast radius of the
// PATCH, not the incident:
//
//   HIGH   — authentication, authorization, infrastructure/cascading,
//            destructive verbs, or a HIGH/CRITICAL incident
//   MEDIUM — the fix touches shared business/schema logic (lib/server) or DB
//            schema/codegen that other endpoints depend on
//   LOW    — isolated, non-security, route-local single-surface fix (e.g. a
//            broken field inside one route file)

import type { Incident } from '@prisma/client'

export type PatchRisk = 'LOW' | 'MEDIUM' | 'HIGH'

export interface RiskDecision {
  risk: PatchRisk
  reason: string
}

function securitySensitivePath(file: string, endpoint: string): boolean {
  const fileLower = file.toLowerCase()
  const secretDomains =
    /(auth|permission|ownership|login|session|password|middleware|authorization|security)/.test(fileLower) ||
    /(auth|login|account|password)/.test(endpoint.toLowerCase())
  return secretDomains
}

function cascadingEndpoint(endpoint: string): boolean {
  return (
    endpoint === '/*' ||
    endpoint === '/api/health' ||
    /health|db|database|stats|dashboard/.test(endpoint) ||
    !/^\/api\//.test(endpoint)
  )
}

function destructiveVerb(method: string | null): boolean {
  return /^(DELETE|PUT)$/.test(method ?? '')
}

function sharedBusinessSurface(file: string): boolean {
  const relative = file.replace(/^frontend\//, '').toLowerCase()
  return (
    /^lib\/server\//.test(relative) ||
    /^prisma\//.test(relative) ||
    relative === 'lib/server/validation.ts' ||
    /schema|serializers|middleware/.test(relative)
  )
}

export function classifyPatchRisk(
  incident: Incident,
  proposedFile: string,
): RiskDecision {
  if (
    securitySensitivePath(proposedFile, incident.endpoint) ||
    cascadingEndpoint(incident.endpoint) ||
    destructiveVerb(incident.method) ||
    incident.severity === 'HIGH' ||
    incident.severity === 'CRITICAL'
  ) {
    return {
      risk: 'HIGH',
      reason: `security-sensitive/auth/cascading/destructive surface: ${proposedFile} · ${incident.method} ${incident.endpoint}`,
    }
  }

  if (sharedBusinessSurface(proposedFile)) {
    return {
      risk: 'MEDIUM',
      reason: `shared business/schema surface: ${proposedFile}`,
    }
  }

  return {
    risk: 'LOW',
    reason: `isolated non-security, route-local fix in ${proposedFile}`,
  }
}