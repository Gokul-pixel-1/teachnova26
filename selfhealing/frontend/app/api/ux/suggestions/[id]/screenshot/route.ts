import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { sandboxDataDir } from '@/lib/server/ux/sandbox'
import { errorResponse } from '@/lib/server/response'

// Serves the sandbox before/after screenshots for one suggestion (operator
// only). Names are whitelisted, so no path outside the suggestion's own
// screenshot folder can be read.
const NAME = /^(baseline|round-[1-9])\.png$/
const ID = /^[a-z0-9]{10,40}$/

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  const { id } = await ctx.params
  const name = new URL(request.url).searchParams.get('name') ?? ''
  if (!ID.test(id) || !NAME.test(name)) return errorResponse('Not found.', 404)
  const file = join(sandboxDataDir(), id, name)
  if (!existsSync(file)) return errorResponse('Not found.', 404)
  return new NextResponse(readFileSync(file), {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' },
  })
}
