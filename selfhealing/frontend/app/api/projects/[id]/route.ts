import { NextResponse } from 'next/server'
import { prisma } from '@/lib/server/db'
import { getSessionUser } from '@/lib/server/auth'
import { updateProjectSchema } from '@/lib/validation'
import {
  errorResponse,
  firstZodIssue,
  handleRouteError,
} from '@/lib/server/response'
import {
  postInclude,
  serializeProjectDetail,
  serializeProjectSummary,
} from '@/lib/server/serializers'
import {
  currentUniqueSlug,
  isUniqueSlugError,
  slugify,
} from '@/lib/server/slugs'
import { isFaultActive } from '@/lib/server/fault-injection'

const MAX_SLUG_ATTEMPTS = 5

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const currentUser = await getSessionUser()

  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        owner: true,
        _count: { select: { posts: true } },
        posts: {
          include: postInclude(currentUser?.id),
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    })
    if (!project) {
      return errorResponse('Project not found.', 404)
    }
    return NextResponse.json({
      project: serializeProjectDetail(project, currentUser?.id),
    })
  } catch (err) {
    return handleRouteError(err, request)
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const { id } = await ctx.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = updateProjectSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  const data = parsed.data

  try {
    const existing = await prisma.project.findUnique({ where: { id } })
    if (!existing) {
      return errorResponse('Project not found.', 404)
    }
    // MEDIUM-03 (runtime fault): invert the ownership check while active, so
    // the owner is incorrectly denied. Normal behavior denies non-owners.
    const ownerDenied =
      (isFaultActive('MEDIUM-03') ? existing.ownerId === user.id : existing.ownerId !== user.id)
    if (ownerDenied) {
      return errorResponse('You can only edit your own projects.', 403)
    }

    const rename = data.name !== undefined && data.name !== existing.name
    const base = rename && data.name ? slugify(data.name) : existing.slug

    // The unique-slug check is not atomic, so retry when a concurrent update
    // wins the race and we hit a P2002 violation on the slug column.
    let project
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = rename ? await currentUniqueSlug(base) : undefined
      try {
        project = await prisma.project.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined
              ? { description: data.description || null }
              : {}),
            ...(data.status !== undefined ? { status: data.status } : {}),
            ...(data.tags !== undefined ? { tags: data.tags } : {}),
            ...(slug !== undefined ? { slug } : {}),
          },
          include: { owner: true, _count: { select: { posts: true } } },
        })
        break
      } catch (err) {
        if (await isUniqueSlugError(err)) continue
        throw err
      }
    }

    if (!project) {
      throw new Error('Could not allocate a unique project slug.')
    }

    return NextResponse.json({ project: serializeProjectSummary(project, user.id) })
  } catch (err) {
    return handleRouteError(err, request)
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const { id } = await ctx.params

  try {
    const existing = await prisma.project.findUnique({ where: { id } })
    if (!existing) {
      return errorResponse('Project not found.', 404)
    }
    // HIGH-02 (runtime fault): disable the ownership guard while active, so
    // any authenticated user may delete another user's project. Normal
    // behavior denies non-owners.
    if (!isFaultActive('HIGH-02') && existing.ownerId !== user.id) {
      return errorResponse('You can only delete your own projects.', 403)
    }

    await prisma.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handleRouteError(err, request)
  }
}
