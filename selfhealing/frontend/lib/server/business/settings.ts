import 'server-only'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

// Business assumptions behind the Impact dashboard, postmortems and status
// page. The company enters its own numbers once; every "money saved" figure
// is derived from them plus REAL incident timings — nothing is hard-coded
// into the reports. Stored beside fault-state.json (frontend/.data), so no
// schema change is needed and the file never reaches git.

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type BusinessSeverity = (typeof SEVERITIES)[number]

const perSeverity = z.object({
  LOW: z.number().min(0),
  MEDIUM: z.number().min(0),
  HIGH: z.number().min(0),
  CRITICAL: z.number().min(0),
})

export const businessSettingsSchema = z.object({
  companyName: z.string().trim().min(1).max(60),
  currency: z.string().trim().min(1).max(4),
  // Revenue the product earns per hour while fully working.
  revenuePerHour: z.number().min(0).max(1e9),
  // Loaded cost of one engineer hour.
  engineerCostPerHour: z.number().min(0).max(1e7),
  // How long the team typically takes to fix an incident by hand (minutes).
  manualMttrMinutes: perSeverity,
  // Share of revenue lost while a surface of that severity is broken (0–1):
  // a broken comment box costs far less than a broken login.
  revenueAtRisk: perSeverity,
  // Engineers pulled in per manual incident.
  engineersPerIncident: perSeverity,
  // AI spend per 1M tokens (prompt + completion), in the same currency.
  aiCostPerMillionTokens: z.number().min(0).max(1e6),
})

export type BusinessSettings = z.infer<typeof businessSettingsSchema>

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  companyName: 'BuildHub',
  currency: '₹',
  revenuePerHour: 25000,
  engineerCostPerHour: 1500,
  manualMttrMinutes: { LOW: 45, MEDIUM: 120, HIGH: 240, CRITICAL: 480 },
  revenueAtRisk: { LOW: 0.05, MEDIUM: 0.3, HIGH: 0.9, CRITICAL: 1 },
  engineersPerIncident: { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 },
  aiCostPerMillionTokens: 30,
}

function settingsPath(): string {
  return resolve(process.cwd(), '.data', 'business-settings.json')
}

export async function readBusinessSettings(): Promise<BusinessSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as unknown
    const parsed = businessSettingsSchema.safeParse({ ...DEFAULT_BUSINESS_SETTINGS, ...(raw as object) })
    return parsed.success ? parsed.data : DEFAULT_BUSINESS_SETTINGS
  } catch {
    return DEFAULT_BUSINESS_SETTINGS
  }
}

export async function writeBusinessSettings(next: BusinessSettings): Promise<BusinessSettings> {
  const parsed = businessSettingsSchema.parse(next)
  await mkdir(dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(parsed, null, 2), 'utf8')
  return parsed
}

export function severityKey(value: string): BusinessSeverity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as BusinessSeverity) : 'MEDIUM'
}
