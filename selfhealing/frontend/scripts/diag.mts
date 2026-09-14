process.env.DATABASE_URL = 'postgresql://buildhub:buildhub_dev_pw@localhost:5432/buildhub'
process.env.SELF_HEALING_TEST_MODE = 'true'
process.env.AI_PROVIDER = 'test'
process.env.AUTO_REPAIR = 'true'

const trigger = await import('../lib/server/repair/auto-trigger').catch((e) => ({ __err: String(e) }))
if ('__err' in trigger) { console.log('TRIGGER IMPORT ERROR', trigger.__err); process.exit(1) }
console.log('autoRepairEnabled =', trigger.autoRepairEnabled())
console.log('autoRepairScenario =', trigger.autoRepairScenario())

const { scanForRuntimeIncidents } = await import('../lib/server/repair/log-monitor')
const { prisma } = await import('../lib/server/db')
const res = await scanForRuntimeIncidents({ limit: 50 })
console.log('scan created=', res.created.map((i) => i.ref), 'merged=', res.openMerged, 'linked=', res.linked)
await new Promise((r) => setTimeout(r, 4000))
const latest = await prisma.incident.findFirst({ orderBy: { createdAt: 'desc' }, include: { events: true, repairAttempts: true } })
console.log('latest incident', latest?.ref, latest?.status, 'attempts=', latest?.repairAttempts?.length)
console.log('events:', (latest?.events ?? []).map((e) => e.stage + ':' + e.label).join(' | '))
await prisma.$disconnect()
